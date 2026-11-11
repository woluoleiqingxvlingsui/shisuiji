' shisuiji graphical console launcher.
' Runs control-ui.ps1 fully hidden: no console window ever appears.
' Node.js is not required: the portable package ships its own runtime (runtime\node.exe).
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(fso.BuildPath(base, "control-ui.ps1")) Then
  MsgBox "control-ui.ps1 was not found next to this launcher.", vbExclamation, "shisuiji"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\control-ui.ps1""", 0, False
