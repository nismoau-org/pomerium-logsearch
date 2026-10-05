// Package dockerclient tails logs from a Docker container with reconnect
// backoff. Read-only by design: only ContainerList (existence check) and
// ContainerLogs are ever called (see docs/SECURITY.md).
package dockerclient

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	containertypes "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"

	"github.com/nismoau-org/pomerium-logsearch/internal/broadcast"
	"github.com/nismoau-org/pomerium-logsearch/internal/buffer"
	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

const (
	readChunkSize = 32 * 1024
	// maxLineBytes bounds one assembled log line; over-long lines are
	// emitted truncated (ParseLine caps storage at 256KB anyway).
	maxLineBytes = 1 << 20
	// maxPendingBytes bounds undecoded multiplex bytes held across reads.
	maxPendingBytes = 4 << 20
	// reconnectTail keeps reconnects cheap: the initial burst uses INIT_TAIL,
	// reconnects after a blip only re-request the last 100 lines.
	reconnectTail  = "100"
	initialBackoff = time.Second
	maxBackoff     = 30 * time.Second
)

// Streamer tails one container into the ring buffer and hub.
type Streamer struct {
	cli       *client.Client
	container string
	tail      int
	ring      *buffer.Ring
	hub       *broadcast.Hub
}

// New builds a Streamer using the standard Docker environment (DOCKER_HOST
// and friends) with API version negotiation.
func New(containerName string, tail int, ring *buffer.Ring, hub *broadcast.Hub) (*Streamer, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	if tail < 0 {
		tail = 0
	}
	return &Streamer{cli: cli, container: containerName, tail: tail, ring: ring, hub: hub}, nil
}

// Close releases the underlying Docker client.
func (s *Streamer) Close() error { return s.cli.Close() }

// Run streams until ctx is cancelled, reconnecting with exponential backoff
// (1s, doubling, 30s max; reset after a minute of healthy streaming).
func (s *Streamer) Run(ctx context.Context) {
	s.checkExists(ctx)
	backoff := initialBackoff
	first := true
	for {
		if ctx.Err() != nil {
			return
		}
		state := "connecting"
		if !first {
			state = "reconnecting"
		}
		s.hub.BroadcastStatus(state, fmt.Sprintf("connecting to container %q...", s.container))
		tail := strconv.Itoa(s.tail)
		if !first {
			tail = reconnectTail
		}
		start := time.Now()
		err := s.streamOnce(ctx, tail)
		if ctx.Err() != nil {
			s.hub.BroadcastStatus("disconnected", "log stream stopped")
			return
		}
		first = false
		if time.Since(start) > time.Minute {
			backoff = initialBackoff
		}
		s.hub.BroadcastStatus("reconnecting",
			fmt.Sprintf("log stream ended (%v); retrying in %s", err, backoff.Round(time.Second)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// checkExists emits a status hint when the target container is absent; the
// retry loop covers it appearing later, so this never fails Run.
func (s *Streamer) checkExists(ctx context.Context) {
	list, err := s.cli.ContainerList(ctx, containertypes.ListOptions{All: true})
	if err != nil {
		s.hub.BroadcastStatus("error", fmt.Sprintf("cannot list containers: %v", err))
		return
	}
	for _, c := range list {
		if c.ID == s.container {
			return
		}
		for _, n := range c.Names {
			if strings.TrimPrefix(n, "/") == s.container {
				return
			}
		}
	}
	s.hub.BroadcastStatus("error", fmt.Sprintf("container %q not found; waiting for it to appear...", s.container))
}

// streamOnce follows the log stream until it ends or ctx is cancelled.
func (s *Streamer) streamOnce(ctx context.Context, tail string) error {
	rc, err := s.cli.ContainerLogs(ctx, s.container, containertypes.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       tail,
	})
	if err != nil {
		return fmt.Errorf("container logs: %w", err)
	}
	defer rc.Close()
	s.hub.BroadcastStatus("connected", fmt.Sprintf("streaming logs from container %q", s.container))

	// Line assembler: carries partial lines across read chunks.
	var lineBuf []byte
	var lineOff int
	feed := func(p []byte) {
		lineBuf = append(lineBuf, p...)
		for {
			rel := bytes.IndexByte(lineBuf[lineOff:], '\n')
			if rel < 0 {
				break
			}
			s.handleLine(lineBuf[lineOff : lineOff+rel])
			lineOff += rel + 1
		}
		if lineOff > 0 { // compact the consumed prefix
			lineBuf = append([]byte(nil), lineBuf[lineOff:]...)
			lineOff = 0
		}
		if len(lineBuf) > maxLineBytes { // runaway line: emit truncated
			s.handleLine(lineBuf[:maxLineBytes])
			lineBuf = lineBuf[:0]
		}
	}
	flush := func() {
		if rest := bytes.TrimSpace(lineBuf[lineOff:]); len(rest) > 0 {
			s.handleLine(rest)
		}
		lineBuf = lineBuf[:0]
		lineOff = 0
	}

	var modeKnown, multiplexed bool
	var pending []byte // raw bytes awaiting frame decode (multiplexed mode)
	chunk := make([]byte, readChunkSize)
	for {
		n, rerr := rc.Read(chunk)
		if n > 0 {
			if !modeKnown {
				pending = append(pending, chunk[:n]...)
				if len(pending) >= 8 || rerr != nil {
					multiplexed = logparse.IsMultiplexed(pending)
					modeKnown = true
				}
			} else if multiplexed {
				pending = append(pending, chunk[:n]...)
			} else {
				feed(chunk[:n])
			}
			if modeKnown {
				if multiplexed {
					for {
						payload, rest, ok := logparse.DemuxDockerFrame(pending)
						if !ok {
							break
						}
						feed(payload)
						pending = rest
					}
					if len(pending) >= 8 && !logparse.IsMultiplexed(pending) {
						feed(pending) // desync fallback: treat as plain bytes
						pending = pending[:0]
					} else if len(pending) > maxPendingBytes {
						feed(pending) // corrupt-peer guard: never grow unbounded
						pending = pending[:0]
					}
				} else if len(pending) > 0 {
					feed(pending) // drain pre-detection bytes (once)
					pending = nil
				}
			}
		}
		if rerr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if rerr == io.EOF {
				flush()
				return fmt.Errorf("stream closed by daemon")
			}
			return fmt.Errorf("stream read: %w", rerr)
		}
	}
}

// handleLine parses, buffers and broadcasts one assembled line.
func (s *Streamer) handleLine(line []byte) {
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	entry := logparse.ParseLine(string(line), s.container)
	if entry.ID == "" {
		return
	}
	s.ring.Add(entry)
	s.hub.BroadcastLog(entry)
}
