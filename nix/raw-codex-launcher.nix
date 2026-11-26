{
  lib,
  stdenv,
  coreutils,
  systemdMinimal,
  util-linux,
}:
let
  launcher = ../tests/fixtures/bun-exec-pid-namespace.c;
  exec = ../tests/fixtures/bun-exec-launcher.c;
  sourceSha256 = builtins.hashString "sha256" (
    builtins.hashFile "sha256" launcher + builtins.hashFile "sha256" exec
  );
  version = "1";
in
stdenv.mkDerivation {
  pname = "raw-codex-launcher";
  inherit version;
  passthru = { inherit sourceSha256; };
  meta.platforms = lib.platforms.linux;
  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    cp ${launcher} bun-exec-pid-namespace.c
    cp ${exec} bun-exec-launcher.c
    "$CC" -std=c11 -O2 -Wall -Wextra -Werror -DRAW_CODEX_LAUNCHER \
      '-DPROCESS_PROOF_UNSHARE="${lib.getExe' util-linux "unshare"}"' \
      '-DPROCESS_PROOF_TRUE="${lib.getExe' coreutils "true"}"' \
      '-DPROCESS_PROOF_SYSTEMD_RUN="${lib.getExe' systemdMinimal "systemd-run"}"' \
      bun-exec-pid-namespace.c -o raw-codex-launcher
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 raw-codex-launcher "$out/bin/raw-codex-launcher"
    runHook postInstall
  '';

  postFixup = ''
    digest="$(sha256sum "$out/bin/raw-codex-launcher")"
    mkdir -p "$out/share/raw-codex-launcher"
    printf '{"version":"%s","sourceSha256":"%s","sha256":"%s"}\n' \
      '${version}' '${sourceSha256}' "''${digest%% *}" > "$out/share/raw-codex-launcher/manifest.json"
  '';
}
