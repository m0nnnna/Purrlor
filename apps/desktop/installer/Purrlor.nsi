!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

; Packs electron-builder's dist-app\win-unpacked (scripts/installer.mjs runs this). The install
; folder, uninstall key and the /S /RELAUNCH /TRAY switches are the 1.x installer's, so a 1.x app's
; auto-update installs this straight over itself.

!define APPNAME "Purrlor"
!ifndef APPVERSION
  !define APPVERSION "0.0.0"
!endif
!define EXE_NAME "Purrlor.exe"
!define OUTFILE "..\dist-app\Purrlor-Setup.exe"
; Programs go under Programs\; %LOCALAPPDATA%\Purrlor is the app's settings and browser data,
; which an upgrade or uninstall must leave alone (that's where people's sign-ins live).
!define INSTALLDIR "$LOCALAPPDATA\Programs\Purrlor"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Purrlor"

Icon "purrlor.ico"
UninstallIcon "purrlor.ico"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "${INSTALLDIR}"
RequestExecutionLevel user
Unicode True
SetCompressor /SOLID lzma

VIProductVersion "${APPVERSION}.0"
VIAddVersionKey "ProductName" "Purrlor"
VIAddVersionKey "CompanyName" "MeowOps"
VIAddVersionKey "FileDescription" "Purrlor Desktop Installer"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"
VIAddVersionKey "LegalCopyright" "MeowOps"

!define MUI_ICON "purrlor.ico"
!define MUI_UNICON "purrlor.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Start Purrlor"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Purrlor keeps running in the tray after its window is closed, so an upgrade or uninstall has to
; stop it first or its files are locked. Electron runs several Purrlor.exe processes; this stops all.
!macro StopPurrlor
  nsExec::Exec 'taskkill /IM "${EXE_NAME}" /F /T'
  Pop $0
  Sleep 800
!macroend

Section "Purrlor" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  !insertmacro StopPurrlor
  ; Replace, don't merge: files a newer build dropped (or the whole 1.x .NET app) shouldn't linger.
  ; $INSTDIR is always the fixed Programs\Purrlor folder (there's no directory page), so this only
  ; ever removes our files.
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "..\dist-app\win-unpacked\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "MeowOps"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE_NAME},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section /o "Desktop Shortcut" SEC_DESKTOP
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Purrlor.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
SectionEnd

; Not optional: Windows shows an app's notifications only when a Start menu shortcut carries its ID
; (the app writes the ID onto this shortcut when it starts).
Section "Start Menu Shortcut" SEC_STARTMENU
  SectionIn RO
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\Purrlor"
  CreateShortCut "$SMPROGRAMS\Purrlor\Purrlor.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  ; The 1.x installer added an uninstall shortcut here; Settings → Apps does that job.
  Delete "$SMPROGRAMS\Purrlor\Uninstall Purrlor.lnk"
SectionEnd

; An automatic update (src/main/updater.ts, or a 1.x app's Updater.cs) runs this silently: /S, plus
; /RELAUNCH to start the new version afterwards (/TRAY: in the tray, as at sign-in).
Function .onInstSuccess
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/RELAUNCH" $1
  ${IfNot} ${Errors}
    ClearErrors
    ${GetOptions} $0 "/TRAY" $1
    ${If} ${Errors}
      Exec '"$INSTDIR\${EXE_NAME}"'
    ${Else}
      Exec '"$INSTDIR\${EXE_NAME}" --tray'
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopPurrlor
  Delete "$DESKTOP\Purrlor.lnk"
  Delete "$SMPROGRAMS\Purrlor\Purrlor.lnk"
  Delete "$SMPROGRAMS\Purrlor\Uninstall Purrlor.lnk"
  RMDir "$SMPROGRAMS\Purrlor"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Purrlor"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; The 1.x app's registration for its notifications (Microsoft.Toolkit's compat layer).
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\Purrlor"
  RMDir /r "$INSTDIR"
SectionEnd
