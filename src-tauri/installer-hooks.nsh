; Remove the old newman-runner.exe sidecar left over from installs before the
; native Rust runner (removed in 8ab61bf). Tauri's NSIS updater doesn't clean
; up externalBins that no longer exist in the new version.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\newman-runner.exe"
!macroend
