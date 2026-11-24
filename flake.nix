{
  description = "Round Table dashboard: development shell with the toolchain CI uses";

  # Same nixpkgs pin as roundtable-k8s/roundtable's flake.nix (flake.lock is identical).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/2786a2a72088ecf32aea5b3ec52099e6a7cff78f";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Keep in sync with .github/workflows/build.yaml:
      #   - Node 22 (actions/setup-node, node-version '22') -> nodejs_22
      #   - Go from api/go.mod (`go 1.25.0`, setup-go go-version-file). The pinned
      #     nixpkgs has no go_1_25 attribute, so go_1_26 is used; it satisfies the
      #     go.mod minimum and is what the roundtable repo pins too.
      devTools =
        pkgs: with pkgs; [
          nodejs_22
          go_1_26
          git
          gh
          jq
        ];
    in
    {
      # Everything in devShells.default as one installable environment, for knight
      # images: `nix build .#knight-tools` -> <result>/bin/*. No shell hooks.
      packages = forAllSystems (pkgs: {
        knight-tools = pkgs.buildEnv {
          name = "knight-tools";
          paths = devTools pkgs;
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = devTools pkgs;
        };
      });

      checks = forAllSystems (
        pkgs:
        let
          t = pkgs.buildEnv {
            name = "knight-tools";
            paths = devTools pkgs;
          };
        in
        {
        tool-versions = pkgs.runCommand "tool-versions" { } ''
          node_v="$(${t}/bin/node --version)"
          case "$node_v" in v22.*) ;; *) echo "node: want v22.x, got $node_v" >&2; exit 1;; esac
          go_v="$(${t}/bin/go version)"
          case "$go_v" in *"go1.26"*) ;; *) echo "go: want go1.26.x, got $go_v" >&2; exit 1;; esac
          for bin in node npm npx go git gh jq; do
            test -x ${t}/bin/$bin || { echo "knight-tools: missing bin/$bin" >&2; exit 1; }
          done
          touch $out
        '';
        }
      );
    };
}
