!macro customCheckAppRunning
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close ${PRODUCT_NAME} before continuing. Save your work, quit the app, and run setup again." /SD IDOK
    SetErrorLevel 2
    Quit
  ; nsProcess returns 603 when no matching process is running.
  ${ElseIf} $R0 != 603
    MessageBox MB_OK|MB_ICONSTOP "Setup could not check whether ${PRODUCT_NAME} is running. Your installation has not been changed. Restart Windows and try again." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend
