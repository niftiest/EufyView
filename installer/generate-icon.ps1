# Generate tray icon (.ico) for EufyView
# Dark bg #0F0F0F + blue accent #4A9EFF + letter "E"

param(
    [string]$OutputPath = (Join-Path $PSScriptRoot "tray-icon.ico")
)

Add-Type -AssemblyName System.Drawing

function Create-IconBitmap($sz) {
    [int]$s = $sz
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $bgColor = [System.Drawing.Color]::FromArgb(15, 15, 15)
    $accentColor = [System.Drawing.Color]::FromArgb(74, 158, 255)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    [int]$penW = [Math]::Max(1, [int]($s / 48))
    $borderPen = New-Object System.Drawing.Pen($accentColor, $penW)

    [int]$radius = [int]($s * 0.2)
    [int]$w = $s - 1
    [int]$h = $s - 1

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $radius, $radius, 180, 90)
    $path.AddArc([int]($w - $radius), 0, $radius, $radius, 270, 90)
    $path.AddArc([int]($w - $radius), [int]($h - $radius), $radius, $radius, 0, 90)
    $path.AddArc(0, [int]($h - $radius), $radius, $radius, 90, 90)
    $path.CloseFigure()

    $g.FillPath($bgBrush, $path)
    $g.DrawPath($borderPen, $path)

    [int]$fontSize = [Math]::Max(6, [int]($s * 0.55))
    $font = New-Object System.Drawing.Font("Consolas", $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush($accentColor)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $textRect = New-Object System.Drawing.RectangleF(0, [float]($s * -0.02), [float]$s, [float]$s)
    $g.DrawString("E", $font, $textBrush, $textRect, $sf)

    $g.Dispose()
    $font.Dispose()
    $textBrush.Dispose()
    $bgBrush.Dispose()
    $borderPen.Dispose()
    $sf.Dispose()
    $path.Dispose()

    return $bmp
}

# Create bitmaps at standard icon sizes
$bmp16 = Create-IconBitmap 16
$bmp24 = Create-IconBitmap 24
$bmp32 = Create-IconBitmap 32
$bmp48 = Create-IconBitmap 48
$bmp64 = Create-IconBitmap 64
$bmp256 = Create-IconBitmap 256
$allBitmaps = @($bmp16, $bmp24, $bmp32, $bmp48, $bmp64, $bmp256)

# Write ICO file
$ms = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($ms)

# ICO header
$writer.Write([UInt16]0)                    # Reserved
$writer.Write([UInt16]1)                    # Type: ICO
$writer.Write([UInt16]$allBitmaps.Count)    # Image count

# Pre-render all PNGs
$pngDataList = @()
foreach ($bmp in $allBitmaps) {
    $pngMs = New-Object System.IO.MemoryStream
    $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngDataList += ,($pngMs.ToArray())
    $pngMs.Dispose()
}

# ICO directory entries (header=6, each entry=16 bytes)
[int]$dataOffset = 6 + ($allBitmaps.Count * 16)
for ($i = 0; $i -lt $allBitmaps.Count; $i++) {
    $bmp = $allBitmaps[$i]
    $pngBytes = $pngDataList[$i]
    [byte]$bw = if ($bmp.Width -ge 256) { 0 } else { [byte]$bmp.Width }
    [byte]$bh = if ($bmp.Height -ge 256) { 0 } else { [byte]$bmp.Height }

    $writer.Write($bw)                          # Width
    $writer.Write($bh)                          # Height
    $writer.Write([byte]0)                      # Color palette
    $writer.Write([byte]0)                      # Reserved
    $writer.Write([UInt16]1)                    # Color planes
    $writer.Write([UInt16]32)                   # Bits per pixel
    $writer.Write([UInt32]$pngBytes.Length)      # Image data size
    $writer.Write([UInt32]$dataOffset)           # Offset to image data

    $dataOffset += $pngBytes.Length
}

# Image data
foreach ($pngBytes in $pngDataList) {
    $writer.Write($pngBytes)
}

[System.IO.File]::WriteAllBytes($OutputPath, $ms.ToArray())
$writer.Dispose()
$ms.Dispose()
foreach ($bmp in $allBitmaps) { $bmp.Dispose() }

Write-Host "Icon generated: $OutputPath ($((Get-Item $OutputPath).Length) bytes)"
