' Запускает run-agent.cmd без окна консоли (используется автозапуском Windows).
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run """" & scriptDir & "\run-agent.cmd""", 0, False
