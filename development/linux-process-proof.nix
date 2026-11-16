{ system, revision }:
let
  pkgs = import (builtins.fetchTarball "https://github.com/NixOS/nixpkgs/archive/${revision}.tar.gz") { inherit system; };
in
{
  bash = pkgs.bash;
  stdenv = pkgs.stdenv;
}
