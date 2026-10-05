// Package config resolves server configuration from flags and environment.
// Environment variables seed the flag defaults and win over explicit flags.
package config

import (
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

const (
	DefaultContainer  = "pomerium"
	DefaultBindAddr   = "127.0.0.1:8081"
	DefaultBufferSize = 10000
	DefaultInitTail   = 1000
)

// Config is the resolved server configuration.
type Config struct {
	Container   string
	BindAddr    string
	BufferSize  int
	InitTail    int
	AllowRemote bool
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return fallback
}

func getenvBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// Load parses args (flags) with defaults seeded from the environment, then
// applies set environment variables over the parsed flags, so env wins.
func Load(args []string) Config {
	fs := flag.NewFlagSet("pomerium-logsearch", flag.ContinueOnError)
	container := fs.String("container", getenv("POMERIUM_CONTAINER", DefaultContainer),
		"Docker container to tail (env POMERIUM_CONTAINER)")
	bind := fs.String("bind", getenv("BIND_ADDR", DefaultBindAddr),
		"HTTP bind address, host:port (env BIND_ADDR)")
	bufferSize := fs.Int("buffer-size", getenvInt("BUFFER_SIZE", DefaultBufferSize),
		"in-memory ring capacity in lines (env BUFFER_SIZE)")
	initTail := fs.Int("init-tail", getenvInt("INIT_TAIL", DefaultInitTail),
		"lines requested on first connect (env INIT_TAIL)")
	allowRemote := fs.Bool("allow-remote", getenvBool("ALLOW_REMOTE"),
		"permit binding a non-loopback address (env ALLOW_REMOTE)")
	_ = fs.Parse(args)

	cfg := Config{
		Container:   strings.TrimSpace(*container),
		BindAddr:    strings.TrimSpace(*bind),
		BufferSize:  *bufferSize,
		InitTail:    *initTail,
		AllowRemote: *allowRemote,
	}
	if v := os.Getenv("POMERIUM_CONTAINER"); v != "" {
		cfg.Container = strings.TrimSpace(v)
	}
	if v := os.Getenv("BIND_ADDR"); v != "" {
		cfg.BindAddr = strings.TrimSpace(v)
	}
	if v := os.Getenv("BUFFER_SIZE"); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			cfg.BufferSize = n
		}
	}
	if v := os.Getenv("INIT_TAIL"); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			cfg.InitTail = n
		}
	}
	if os.Getenv("ALLOW_REMOTE") != "" {
		cfg.AllowRemote = getenvBool("ALLOW_REMOTE")
	}
	if cfg.Container == "" {
		cfg.Container = DefaultContainer
	}
	if cfg.BindAddr == "" {
		cfg.BindAddr = DefaultBindAddr
	}
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = DefaultBufferSize
	}
	if cfg.InitTail < 0 {
		cfg.InitTail = 0
	}
	return cfg
}

// Validate enforces the bind guard (docs/SECURITY.md): a non-loopback bind
// is refused unless AllowRemote is set. The MVP has no auth, so remote
// exposure is strictly opt-in.
func (c Config) Validate() error {
	host, _, err := net.SplitHostPort(c.BindAddr)
	if err != nil {
		return fmt.Errorf("invalid bind address %q: %w", c.BindAddr, err)
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	switch host {
	case "127.0.0.1", "localhost", "::1":
		return nil
	}
	if strings.HasPrefix(host, "127.") {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	// Empty/wildcard ("", "0.0.0.0", "::") and any other host are remote.
	if !c.AllowRemote {
		return fmt.Errorf("refusing to bind non-loopback address %q without --allow-remote "+
			"(or ALLOW_REMOTE=1): MVP has no auth, so remote exposure is opt-in "+
			"(see docs/SECURITY.md; container deployments must bind 0.0.0.0 internally "+
			"and keep the host `ports:` mapping loopback-only)", c.BindAddr)
	}
	return nil
}
