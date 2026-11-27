package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// version is the release version; set at build time with
// -ldflags "-X main.version=<v>" (Dockerfile ARG VERSION).
var version = "dev"

// commit is the git SHA; set with -X main.commit=<sha> (Dockerfile ARG COMMIT).
// Used when Go's embedded VCS info is absent (the Docker build has no .git).
var commit = ""

type versionInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
	GoVersion string `json:"goVersion"`
}

// currentVersion combines the ldflags version with the VCS data Go embeds.
func currentVersion() versionInfo {
	v := versionInfo{Version: version, Commit: commit}
	if bi, ok := debug.ReadBuildInfo(); ok {
		v.GoVersion = bi.GoVersion
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if v.Commit == "" {
					v.Commit = s.Value
				}
			case "vcs.time":
				v.BuildTime = s.Value
			}
		}
	}
	return v
}

// versionHandler serves GET /api/version.
func versionHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(currentVersion()); err != nil {
			slog.DebugContext(r.Context(), "Failed to encode version", "error", err)
		}
	}
}
