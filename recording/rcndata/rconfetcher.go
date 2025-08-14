package rcndata

import (
	"fmt"
	"time"

	"hllobserver/rconv2"

	"hllobserver/hll"
)

type RconDataSnapshot struct {
	Players     []hll.DetailedPlayerInfo
	PlayerMap   map[string]hll.DetailedPlayerInfo
	CurrentMap  hll.GameMap
	SessionInfo hll.SessionInfo
	FetchTime   time.Time
}

type DataFetcher interface {
	FetchRconDataSnapshot() (*RconDataSnapshot, error)
	StartCurrentEndTime() (time.Time, time.Time, time.Time)
	IsUserSeekable() bool
	IsPaused() bool
	Pause()
	Continue()
	Seek(time.Duration)
}

type RconDataFetcher struct {
	rcon *rconv2.Rcon
}

func NewRconDataFetcher(rcon *rconv2.Rcon) *RconDataFetcher {
	return &RconDataFetcher{
		rcon: rcon,
	}
}

func (f *RconDataFetcher) FetchRconDataSnapshot() (*RconDataSnapshot, error) {
	sessionInfo, err := f.rcon.GetSessionInfo()
	if err != nil {
		return nil, fmt.Errorf("GetSessionInfo failed: %v", err)
	}

	players, err := f.rcon.GetPlayersInfo()
	if err != nil {
		return nil, fmt.Errorf("GetPlayersInfo failed: %v", err)
	}

	playerMap := make(map[string]hll.DetailedPlayerInfo)
	for _, player := range players {
		playerMap[player.ID] = player
	}

	return &RconDataSnapshot{
		Players:     players,
		PlayerMap:   playerMap,
		CurrentMap:  hll.LogMapNameToMap(sessionInfo.MapName),
		SessionInfo: sessionInfo,
		FetchTime:   time.Now(),
	}, nil
}

func (f *RconDataFetcher) StartCurrentEndTime() (time.Time, time.Time, time.Time) {
	return time.Time{}, time.Time{}, time.Time{}
}
func (f *RconDataFetcher) IsUserSeekable() bool { return false }
func (f *RconDataFetcher) IsPaused() bool       { return false }
func (f *RconDataFetcher) Pause()               {}
func (f *RconDataFetcher) Continue()            {}
func (f *RconDataFetcher) Seek(time.Duration)   {}
