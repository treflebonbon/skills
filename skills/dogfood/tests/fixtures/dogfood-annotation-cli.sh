#!/usr/bin/env bash
set -euo pipefail
case " $* " in
*" show --help "*) printf '%s\n' '--annotate' ;;
*" attach "*) ;;
*" show --annotate --json "*)
  if [[ ",${DOGFOOD_FAULTS:-}," == *,show-json,* ]]; then
    printf '%s\n' '{"isError":true,"error":"Annotation client exited with code 1"}'
    if [[ ",${DOGFOOD_FAULTS:-}," == *,cleanup-stderr,* ]]; then
      printf '%s\n' 'Dashboard cleanup failed' >&2
    fi
    exit 1
  fi
  if [[ ",${DOGFOOD_FAULTS:-}," == *,show,* ]]; then
    printf '%s\n' 'show failed' >&2
    exit 1
  fi
  mkdir -p .playwright-cli
  printf '%s\n' image >.playwright-cli/annotation.png
  printf '%s\n' snapshot >.playwright-cli/annotation.yaml
  printf '%s\n' '{"result":"Review this control.\nsession / tab @ https://example.test/ (1440x1000)\n  { x: 10, y: 20, width: 30, height: 40 }: Control is clipped\n- [Annotation image](.playwright-cli/annotation.png)\n- [Annotation snapshot](.playwright-cli/annotation.yaml)"}'
  ;;
*" detach "*)
  if [[ ",${DOGFOOD_FAULTS:-}," == *,detach,* ]]; then
    printf '%s\n' 'detach failed' >&2
    exit 1
  fi
  ;;
*) exit 2 ;;
esac
