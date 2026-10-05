// Command pomerium-logsearch tails a Pomerium Docker container and serves a
// local-only web UI (embedded static files) with live logs over WebSocket.
package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nismoau-org/pomerium-logsearch/internal/broadcast"
	"github.com/nismoau-org/pomerium-logsearch/internal/buffer"
	"github.com/nismoau-org/pomerium-logsearch/internal/config"
	"github.com/nismoau-org/pomerium-logsearch/internal/dockerclient"
	"github.com/nismoau-org/pomerium-logsearch/internal/server"
)

//go:embed web/*
var webFS embed.FS

func main() {
	cfg := config.Load(os.Args[1:])
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config: %v", err)
	}

	ring := buffer.New(cfg.BufferSize)
	hub := broadcast.New()
	srv := server.New(ring, hub, cfg.Container)

	// webFS holds web/<files> (go:embed preserves the top directory);
	// serve from the "web" subtree so index.html sits at the FS root.
	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embedded UI: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if os.Getenv("SKIP_DOCKER") == "1" {
		log.Printf("docker streaming disabled (SKIP_DOCKER=1)")
	} else {
		streamer, err := dockerclient.New(cfg.Container, cfg.InitTail, ring, hub)
		if err != nil {
			log.Fatalf("docker: %v", err)
		}
		defer streamer.Close()
		go streamer.Run(ctx)
	}

	httpSrv := &http.Server{Addr: cfg.BindAddr, Handler: srv.Routes(staticFS)}

	log.Printf("pomerium-logsearch: container=%q bind=%s buffer=%d init-tail=%d",
		cfg.Container, cfg.BindAddr, cfg.BufferSize, cfg.InitTail)
	go func() {
		log.Printf("listening on http://%s", cfg.BindAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
