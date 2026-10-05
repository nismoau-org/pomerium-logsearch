package server

import (
	"io/fs"
	"testing/fstest"
)

// testrStaticFS returns a minimal in-memory web dir for handler tests
// (the real embedded UI is wired in main.go via go:embed).
func testrStaticFS() fs.FS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<html>test</html>")},
		"app.js":     {Data: []byte("console.log(1)")},
		"styles.css": {Data: []byte("body{}")},
	}
}
