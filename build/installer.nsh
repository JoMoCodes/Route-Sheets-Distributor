; Custom installer steps, picked up automatically by electron-builder (build/installer.nsh).
;
; Adds a "Shortcuts" page with a "Create a desktop shortcut" checkbox (ticked by default).
; electron-builder creates the desktop shortcut on install; if the box is unticked we remove it
; again in customInstall. Updates from inside the app (--updated) skip the page and leave the
; shortcut exactly as the user has it.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var DesktopShortcutCheckbox
  Var WantDesktopShortcut

  !macro customPageAfterChangeDir
    Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave

    Function DesktopShortcutPageCreate
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose whether to add a shortcut to the desktop."
      nsDialogs::Create 1018
      Pop $0
      ${if} $0 == error
        Abort
      ${endif}
      ${NSD_CreateCheckbox} 0 0 100% 12u "Create a desktop shortcut"
      Pop $DesktopShortcutCheckbox
      ${if} $WantDesktopShortcut != "no"
        ${NSD_Check} $DesktopShortcutCheckbox
      ${endif}
      ${NSD_CreateLabel} 0 20u 100% 24u "Route Sheet Distributor is always added to the Start menu."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function DesktopShortcutPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $WantDesktopShortcut "yes"
      ${else}
        StrCpy $WantDesktopShortcut "no"
      ${endif}
    FunctionEnd
  !macroend

  !macro customInstall
    ${if} $WantDesktopShortcut == "no"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}
  !macroend
!endif
