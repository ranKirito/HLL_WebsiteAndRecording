package main

import (
	"fmt"
	"log"
	"os"

	"hllobserver/record" // Change this to the correct import path if needed

	"google.golang.org/protobuf/proto"
)

func main() {
	filename := "kursk_2025-06-22_21-17.hll" // CHANGE to your actual .hll filename
	data, err := os.ReadFile(filename)
	if err != nil {
		log.Fatalf("Failed to read file: %v", err)
	}

	var match record.MatchData
	if err := proto.Unmarshal(data, &match); err != nil {
		log.Fatalf("Failed to parse file: %v", err)
	}

	// Print header info
	fmt.Println("Map ID:", match.GetHeader().GetMapId())
	fmt.Println("Players:")
	for _, p := range match.GetHeader().GetPlayers() {
		fmt.Printf(" - %s (SteamID: %s, RecordID: %d)\n", p.GetName(), p.GetId(), p.GetRecordId())
	}

	fmt.Println("\n--- Snapshots and Kill Events ---")
	for idx, snap := range match.GetSnapshots() {
		fmt.Printf("\nSnapshot #%d, Time: %v\n", idx, snap.GetTimestamp().AsTime())

		for _, kill := range snap.GetKills() {
			killerName := getPlayerNameByRecordId(match.GetHeader().GetPlayers(), kill.GetKillerId())
			victimName := getPlayerNameByRecordId(match.GetHeader().GetPlayers(), kill.GetVictimId())
			fmt.Printf("  Kill: %s -> %s\n", killerName, victimName)
		}
	}
}

func getPlayerNameByRecordId(players map[string]*record.MatchPlayer, recordId int32) string {
	for _, p := range players {
		if p.GetRecordId() == recordId {
			return p.GetName()
		}
	}
	return fmt.Sprintf("(UnknownID: %d)", recordId)
}
