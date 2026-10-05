package config

import (
	"testing"
)

func TestDefaults(t *testing.T) {
	t.Setenv("POMERIUM_CONTAINER", "")
	t.Setenv("BIND_ADDR", "")
	t.Setenv("BUFFER_SIZE", "")
	t.Setenv("INIT_TAIL", "")
	t.Setenv("ALLOW_REMOTE", "")
	cfg := Load(nil)
	if cfg.Container != DefaultContainer {
		t.Errorf("Container = %q, want %q", cfg.Container, DefaultContainer)
	}
	if cfg.BindAddr != DefaultBindAddr {
		t.Errorf("BindAddr = %q, want %q", cfg.BindAddr, DefaultBindAddr)
	}
	if cfg.BufferSize != DefaultBufferSize || cfg.InitTail != DefaultInitTail {
		t.Errorf("sizes = %d/%d", cfg.BufferSize, cfg.InitTail)
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("default config must validate: %v", err)
	}
}

func TestEnvWinsOverFlags(t *testing.T) {
	t.Setenv("POMERIUM_CONTAINER", "from-env")
	cfg := Load([]string{"--container", "from-flag"})
	if cfg.Container != "from-env" {
		t.Errorf("Container = %q, want env value", cfg.Container)
	}
}

func TestBindGuard(t *testing.T) {
	loopback := Config{Container: "pomerium", BindAddr: "127.0.0.1:8081"}
	if err := loopback.Validate(); err != nil {
		t.Errorf("loopback must validate: %v", err)
	}
	wildcard := Config{Container: "pomerium", BindAddr: "0.0.0.0:8081"}
	if err := wildcard.Validate(); err == nil {
		t.Error("wildcard bind without --allow-remote must be refused")
	}
	allowed := Config{Container: "pomerium", BindAddr: "0.0.0.0:8081", AllowRemote: true}
	if err := allowed.Validate(); err != nil {
		t.Errorf("explicit opt-in must validate: %v", err)
	}
	if err := (Config{BindAddr: "not-an-addr"}).Validate(); err == nil {
		t.Error("malformed bind address must fail validation")
	}
}
