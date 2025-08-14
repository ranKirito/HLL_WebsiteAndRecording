package record

import (
	"fmt"
	"os"
	"path"
	"regexp"

	"time"

	"hllobserver/hll"
	"hllobserver/rcndata"
	"hllobserver/rcon"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	VERSION                = "1.1"
	FULL_SNAPSHOT_INTERVAL = 5 * time.Minute
)

var killRegex = regexp.MustCompile(`KILL: (.+)\((\w+)\/([^)]+)\) -> (.+)\((\w+)\/([^)]+)\) with (.+)`)

type parsedKillEvent struct {
	KillerName string
	KillerTeam string
	KillerID   string
	VictimName string
	VictimTeam string
	VictimID   string
	Weapon     string
}

func parseKillLine(line string) *parsedKillEvent {
	matches := killRegex.FindStringSubmatch(line)
	if matches == nil {
		return nil
	}
	return &parsedKillEvent{
		KillerName: matches[1],
		KillerTeam: matches[2],
		KillerID:   matches[3],
		VictimName: matches[4],
		VictimTeam: matches[5],
		VictimID:   matches[6],
		Weapon:     matches[7],
	}
}

type DataRecorder interface {
	RecordSnapshot(data *rcndata.RconDataSnapshot)
	MapChanged(newMap hll.GameMap)
	Stop()
}

type NoRecorder struct{}

func (nr *NoRecorder) RecordSnapshot(data *rcndata.RconDataSnapshot) {}
func (nr *NoRecorder) MapChanged(newMap hll.GameMap)                 {}
func (nr *NoRecorder) Stop()                                         {}

func NewNoRecorder() *NoRecorder {
	return &NoRecorder{}
}

type MatchRecorder struct {
	recordPath           string
	isRecording          bool
	lastTimeFullSnapshot time.Time
	header               *MatchHeader
	snapshots            []*Snapshot
	oldData              *rcndata.RconDataSnapshot
	rconClient           *rcon.Rcon
	killRegex            *regexp.Regexp
	lastLog              string
	lastLogIndex         int
}

// NewMatchRecorder creates a new MatchRecorder. Pass rconClient or nil if not available.
func NewMatchRecorder(recordPath string, gameMap hll.GameMap, rconClient *rcon.Rcon) (*MatchRecorder, error) {
	mr := &MatchRecorder{
		recordPath:  recordPath,
		isRecording: true,
		header: &MatchHeader{
			Version:   VERSION,
			MapId:     string(gameMap.ID),
			StartTime: timestamppb.Now(),
			Players:   make(map[string]*MatchPlayer),
		},
		snapshots:  []*Snapshot{},
		rconClient: rconClient,
	}
	killPattern := regexp.MustCompile(`KILL: .*\((\d+)\) killed .*\((\d+)\)`)
	mr.killRegex = killPattern

	err := mr.createRecordingDirectory()
	if err != nil {
		return nil, fmt.Errorf("failed to create recording directory: %w", err)
	}
	return mr, nil
}

func (mr *MatchRecorder) RecordSnapshot(newData *rcndata.RconDataSnapshot) {
	if !mr.isRecording {
		return
	}

	isFullSnapshot := len(mr.snapshots) == 0 || time.Since(mr.lastTimeFullSnapshot) >= FULL_SNAPSHOT_INTERVAL

	snapshot := &Snapshot{
		Index:     int32(len(mr.snapshots)),
		Timestamp: timestamppb.Now(),
	}
	if isFullSnapshot {
		fullSnapshot := &FullSnapshot{}
		for _, player := range newData.Players {
			if _, exists := mr.header.Players[player.ID]; !exists {
				playerCount := len(mr.header.Players)
				mr.header.Players[player.ID] = &MatchPlayer{
					Name:     player.Name,
					Id:       player.ID,
					RecordId: int32(playerCount),
					Level:    int32(player.Level),
					ClanTag:  player.ClanTag,
				}
			}

			fullSnapshot.Players = append(fullSnapshot.Players, &PlayerState{
				PlayerId: int32(mr.header.Players[player.ID].RecordId),
				X:        int32(player.Position.X),
				Y:        int32(player.Position.Y),
				Kills:    int32(player.Kills),
				Deaths:   int32(player.Deaths),
				Team:     int32(player.Team.ToInt()),
				Unit:     int32(player.Unit.ID),
				Role:     int32(player.Role.ToInt()),
			})
		}
		snapshot.Data = &Snapshot_FullSnapshot{FullSnapshot: fullSnapshot}
		mr.lastTimeFullSnapshot = time.Now()
	} else {
		if mr.oldData == nil {
			mr.oldData = newData
		}
		deltaSnapshot := &DeltaSnapshot{}
		for _, player := range newData.Players {
			if existingPlayer, exists := mr.header.Players[player.ID]; exists {
				oldPlayerData := mr.oldData.PlayerMap[player.ID]
				playerDelta := &PlayerDelta{
					PlayerId: int32(existingPlayer.RecordId),
				}
				if player.PlanarDistanceTo(oldPlayerData.Position) > 10 {
					deltaX := int32(player.Position.X - oldPlayerData.Position.X)
					deltaY := int32(player.Position.Y - oldPlayerData.Position.Y)
					playerDelta.X = deltaX
					playerDelta.Y = deltaY
				}
				if player.Kills != oldPlayerData.Kills {
					killsDelta := max(int32(player.Kills-oldPlayerData.Kills), 0)
					playerDelta.Kills = &killsDelta
				}
				if player.Deaths != oldPlayerData.Deaths {
					deathsDelta := max(int32(player.Deaths-oldPlayerData.Deaths), 0)
					playerDelta.Deaths = &deathsDelta
				}
				if player.Team != oldPlayerData.Team {
					team := int32(oldPlayerData.Team.ToInt())
					playerDelta.Team = &team
				}
				if player.Unit != oldPlayerData.Unit {
					unit := int32(oldPlayerData.Unit.ID)
					playerDelta.Unit = &unit
				}
				if player.Role != oldPlayerData.Role {
					role := int32(oldPlayerData.Role.ToInt())
					playerDelta.Role = &role
				}
				deltaSnapshot.Players = append(deltaSnapshot.Players, playerDelta)
			}
		}
		snapshot.Data = &Snapshot_DeltaSnapshot{DeltaSnapshot: deltaSnapshot}
	}

	snapshot.Kills = mr.collectKillEvents()

	mr.snapshots = append(mr.snapshots, snapshot)
	mr.oldData = newData
}

func (mr *MatchRecorder) collectKillEvents() []*KillEvent {
	if mr.rconClient == nil {
		return nil
	}
	logs, err := mr.rconClient.GetLogs(30)
	if err != nil {
		return nil
	}
	fmt.Println(logs)
	var kills []*KillEvent

	for i := mr.lastLogIndex; i < len(logs); i++ {
		line := logs[i]
		if kill := parseKillLine(line); kill != nil {
			killer, ok1 := mr.header.Players[kill.KillerID]
			victim, ok2 := mr.header.Players[kill.VictimID]
			if ok1 && ok2 {
				kills = append(kills, &KillEvent{
					KillerId: killer.RecordId,
					VictimId: victim.RecordId,
				})
				fmt.Println("Recorded kill:", kills[len(kills)-1])
			}
		}
	}

	mr.lastLogIndex = len(logs)

	return kills
}

func (mr *MatchRecorder) MapChanged(gameMap hll.GameMap) {
	mr.Stop()

	newRecorder, err := NewMatchRecorder(mr.recordPath, gameMap, nil) // pass nil if no rconClient available
	if err != nil {
		return
	}

	*mr = *newRecorder
}

func (mr *MatchRecorder) Stop() {
	if !mr.isRecording {
		return
	}

	mr.header.EndTime = timestamppb.Now()

	matchData := &MatchData{
		Header:    mr.header,
		Snapshots: mr.snapshots,
	}

	err := mr.writeToFile(matchData)
	if err != nil {
		fmt.Println(err)
	}

	mr.header = nil
	mr.snapshots = nil

	mr.isRecording = false
}

func (mr *MatchRecorder) createRecordingDirectory() error {
	if _, err := os.Stat(mr.recordPath); os.IsNotExist(err) {
		err = os.MkdirAll(mr.recordPath, os.ModePerm)
		if err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}
	return nil
}

func (mr *MatchRecorder) writeToFile(matchData *MatchData) error {
	err := mr.createRecordingDirectory()
	if err != nil {
		return err
	}

	dataBytes, err := proto.Marshal(matchData)
	if err != nil {
		return fmt.Errorf("failed to serialize match data: %w", err)
	}

	fileName := mr.buildFileName()
	dataFile, err := os.Create(fileName)
	if err != nil {
		return fmt.Errorf("failed to create match data file: %w", err)
	}
	defer dataFile.Close()

	_, err = dataFile.Write(dataBytes)
	if err != nil {
		return fmt.Errorf("failed to write match data to file: %w", err)
	}
	return nil
}

func (mr *MatchRecorder) buildFileName() string {
	date := mr.header.StartTime.AsTime().Local().Format("2006-01-02_15-04")
	return path.Join(mr.recordPath, fmt.Sprintf("%s_%s.hll", mr.header.MapId, date))
}
