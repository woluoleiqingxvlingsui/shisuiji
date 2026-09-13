' shiji graphical console launcher.
' Runs control-ui.ps1 fully hidden: no console window ever appears.
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\control-ui.ps1""", 0, False
