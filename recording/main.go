package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hllobserver/rcndata"
	"hllobserver/rcon"
	"hllobserver/rconv2"
	"hllobserver/record"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// ---- Read config from env with sane defaults (separate V1/V2) ----
	v1Host := getenv("HLL_RCON_V1_HOST", "85.208.197.66")
	v1Port := getenv("HLL_RCON_V1_PORT", "7819")  // NOTE: likely NOT the same as v2
	v1Pass := getenv("HLL_RCON_V1_PASS", "7if4w") // admin/classic RCON password

	v2Host := getenv("HLL_RCON_V2_HOST", "85.208.197.66")
	v2Port := getenv("HLL_RCON_V2_PORT", "7819")  // Web/API (HTTP) port
	v2Pass := getenv("HLL_RCON_V2_PASS", "7if4w") // web/API password (may differ)

	log.Printf("RCON v1 -> %s:%s (pass set: %t)", v1Host, v1Port, v1Pass != "")
	log.Printf("RCON v2 -> %s:%s (pass set: %t)", v2Host, v2Port, v2Pass != "")

	// ---- Setup RCON v1 (classic TCP). This is often a DIFFERENT port/pass. ----
	configV1 := rcon.ServerConfig{Host: v1Host, Port: v1Port, Password: v1Pass}
	clientV1, err := rcon.NewRcon(configV1, 1)
	if err != nil {
		log.Fatalf("Failed to connect to RCON v1: %v", err)
	}
	defer clientV1.Close()
	// v1 smoke test to force auth now, not later
	if _, err := clientV1.GetCurrentMap(); err != nil {
		log.Fatalf("RCON v1 auth/command failed (check v1 host/port/pass): %v", err)

	}

	// ---- Setup RCON v2 (HTTP). Often has different port/pass than v1. ----
	configV2 := rconv2.ServerConfig{Host: v2Host, Port: v2Port, Password: v2Pass}
	clientV2, err := rconv2.NewRcon(configV2, 4)
	if err != nil {
		log.Fatalf("Failed to connect to RCON v2: %v", err)
	}
	defer clientV2.Close()

	if _, err := clientV2.GetSessionInfo(); err != nil {
		log.Fatalf("RCON v2 GetSessionInfo failed: %v", err)
	}

	// Data fetcher
	fetcher := rcndata.NewRconDataFetcher(clientV2)

	// ---- Fetch initial snapshot with capped backoff ----
	var initialSnapshot *rcndata.RconDataSnapshot
	backoff := 1 * time.Second
	for attempts := 1; attempts <= 6; attempts++ { // ~1+2+4+8+16+32 = 63s total
		initialSnapshot, err = fetcher.FetchRconDataSnapshot()
		if err == nil {
			break
		}
		log.Printf("Failed to fetch initial snapshot (attempt %d): %v", attempts, err)
		time.Sleep(backoff)
		backoff *= 2
	}
	if err != nil {
		log.Fatalf("Giving up: cannot fetch initial snapshot: %v", err)
	}

	// Start recorder (uses v1)
	recorder, err := record.NewMatchRecorder("recordings", initialSnapshot.CurrentMap, clientV1)
	if err != nil {
		log.Fatalf("Failed to start recorder: %v", err)
	}

	// Graceful shutdown handler
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stopChan
		fmt.Println("Stopping recorder...")
		recorder.Stop()
		os.Exit(0)
	}()

	fmt.Println("Recording started. Press CTRL+C to stop.")

	for {
		snapshot, err := fetcher.FetchRconDataSnapshot()
		if err != nil {
			log.Printf("Failed to fetch snapshot: %v", err)
		} else {
			recorder.RecordSnapshot(snapshot)
			fmt.Printf("Recorded snapshot at %s with %d players\n",
				time.Now().Format("15:04:05"), len(snapshot.Players))
		}
		time.Sleep(10 * time.Second)
	}
}
