package main

import (
	"encoding/json"
	"net/http"
	"runtime/debug"
)

// version is the release version; set at build time with
// -ldflags "-X main.version=<v>" (Dockerfile ARG VERSION).
var version = "dev"

type versionInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
	GoVersion string `json:"goVersion"`
}

// currentVersion combines the ldflags version with the VCS data Go embeds.
func currentVersion() versionInfo {
	v := versionInfo{Version: version}
	if bi, ok := debug.ReadBuildInfo(); ok {
		v.GoVersion = bi.GoVersion
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				v.Commit = s.Value
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
		json.NewEncoder(w).Encode(currentVersion())
	}
}
