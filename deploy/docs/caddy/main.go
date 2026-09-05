// Entry point for the Caddy binary deploy/docs/Dockerfile compiles in its
// `caddybuild` stage. Same shape as the one xcaddy generates: Caddy's own
// main, plus the standard module set (file_server, encode, headers,
// request_header, the Caddyfile adapter — everything deploy/docs/Caddyfile
// uses). No third-party plugins.
//
// Why Atlas builds Caddy instead of running the official image's binary:
// the official binary is compiled with the Go toolchain and dependency set
// current at Caddy's release, and Trivy reads both out of the binary's
// buildinfo. Between Caddy releases those accumulate fixable CVEs (Go stdlib,
// golang.org/x/*, grpc) that no `apk upgrade` can touch — they are inside the
// binary, not in a package. Compiling here, on a pinned current Go with the
// affected modules bumped, clears them without waiting for the next Caddy
// release. The Dockerfile pins every version; this file just names the
// modules to link.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	// Standard modules — the same set the official caddy image links.
	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}
