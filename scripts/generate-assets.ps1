$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $PSScriptRoot '..\src\assets'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(8,8,72,72,180,90)
$shape.AddArc(176,8,72,72,270,90)
$shape.AddArc(176,176,72,72,0,90)
$shape.AddArc(8,176,72,72,90,90)
$shape.CloseFigure()
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0,0)),([System.Drawing.Point]::new(256,256)),([System.Drawing.Color]::FromArgb(45,212,191)),([System.Drawing.Color]::FromArgb(16,130,120))
$g.FillPath($brush,$shape)
$bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
$bubble.AddArc(48,57,160,134,180,360)
$bubble.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White,$bubble)
$tail = [System.Drawing.Point[]]@([System.Drawing.Point]::new(61,156),[System.Drawing.Point]::new(54,207),[System.Drawing.Point]::new(104,179))
$g.FillPolygon([System.Drawing.Brushes]::White,$tail)
$dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16,149,136))
foreach($x in @(86,120,154)) { $g.FillEllipse($dot,$x,113,17,17) }
$g.Dispose()
$png = Join-Path $assets 'icon.png'
$bitmap.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$brush.Dispose()
$dot.Dispose()
$shape.Dispose()
$bubble.Dispose()
$bytes = [System.IO.File]::ReadAllBytes($png)
$stream = [System.IO.File]::Create((Join-Path $assets 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32)
$writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22); $writer.Write($bytes)
$writer.Dispose()
Write-Output 'Generated Windows icon assets.'
