; Extra installer steps (electron-builder includes this).
; Per-user install, so SHCTX is HKCU: no admin prompt.
;
;   double-click a .tgame        -> tgame Lite plays it
;   right-click a .tgame         -> "Play with tgame Lite" and "Edit with tgame IDE"
;   Start menu                   -> "tgame Lite" and "tgame IDE"

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\.tgame" "" "tgame.Story"
  WriteRegStr SHCTX "Software\Classes\.tgame" "Content Type" "text/plain"
  WriteRegStr SHCTX "Software\Classes\.tgame" "PerceivedType" "text"

  WriteRegStr SHCTX "Software\Classes\tgame.Story" "" "tgame story"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\DefaultIcon" "" "$INSTDIR\resources\tgame-file.ico"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell" "" "open"

  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\open" "MUIVerb" "Play with tgame Lite"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\open" "Icon" "$INSTDIR\resources\lite.ico"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --lite "%1"'

  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\edit" "MUIVerb" "Edit with tgame IDE"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\edit" "Icon" "$INSTDIR\resources\ide.ico"
  WriteRegStr SHCTX "Software\Classes\tgame.Story\shell\edit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --ide "%1"'

  CreateShortCut "$SMPROGRAMS\tgame Lite.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--lite" "$INSTDIR\resources\lite.ico"
  CreateShortCut "$SMPROGRAMS\tgame IDE.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--ide" "$INSTDIR\resources\ide.ico"

  ; tell Explorer the associations changed so icons and menus refresh without a reboot
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\tgame.Story"
  DeleteRegKey SHCTX "Software\Classes\.tgame"
  Delete "$SMPROGRAMS\tgame Lite.lnk"
  Delete "$SMPROGRAMS\tgame IDE.lnk"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
