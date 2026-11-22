# Renders the PhoneBox icon (#10 - Floating Pill Pro, matching the Android launcher icon) as a multi-size .ico.
# Usage: pwsh tools/make-icon.ps1  ->  agent/PhoneBox.Agent/phonebox.ico
Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot '..\agent\PhoneBox.Agent'
$out = Join-Path (Resolve-Path -LiteralPath $outDir).Path 'phonebox.ico'

function C([string]$hex, [int]$alpha = 255) {
    $col = [System.Drawing.ColorTranslator]::FromHtml($hex)
    return [System.Drawing.Color]::FromArgb($alpha, $col.R, $col.G, $col.B)
}

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [Math]::Min($r, [Math]::Min($w, $h) / 2.0)
    if ($r -le 0.5) {
        $p.AddRectangle([System.Drawing.RectangleF]::new($x, $y, $w, $h))
        return $p
    }
    $d = [float]($r * 2.0)
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Fill-GradRoundRect($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [string]$hex1, [string]$hex2, [float]$angle = 135) {
    $path = New-RoundRect $x $y $w $h $r
    $rect = [System.Drawing.RectangleF]::new($x, $y, [Math]::Max(1.0, $w), [Math]::Max(1.0, $h))
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, (C $hex1), (C $hex2), $angle)
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
}

function Fill-SolidRoundRect($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [System.Drawing.Color]$color) {
    $path = New-RoundRect $x $y $w $h $r
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
}

function Draw-StrokeRoundRect($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [System.Drawing.Color]$color, [float]$width) {
    $path = New-RoundRect $x $y $w $h $r
    $pen = New-Object System.Drawing.Pen($color, $width)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($pen, $path)
    $pen.Dispose()
    $path.Dispose()
}

function Draw-GradStrokeRoundRect($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [string]$hex1, [string]$hex2, [float]$width, [float]$angle = 0) {
    $path = New-RoundRect $x $y $w $h $r
    $rect = [System.Drawing.RectangleF]::new($x - $width, $y - $width, [Math]::Max(2.0, $w + $width * 2), [Math]::Max(2.0, $h + $width * 2))
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, (C $hex1), (C $hex2), $angle)
    $pen = New-Object System.Drawing.Pen($brush, $width)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($pen, $path)
    $pen.Dispose()
    $brush.Dispose()
    $path.Dispose()
}

function Draw-GlowCircle($g, [float]$cx, [float]$cy, [float]$radius, [string]$hex, [int]$maxAlpha = 50) {
    for ($i = 4; $i -ge 1; $i--) {
        $rr = [float]($radius * (0.5 + 0.28 * $i))
        $a = [int]($maxAlpha / $i)
        $b = New-Object System.Drawing.SolidBrush((C $hex $a))
        $g.FillEllipse($b, $cx - $rr, $cy - $rr, $rr * 2, $rr * 2)
        $b.Dispose()
    }
}

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [float]($size / 512.0)
    $pad = [float](16 * $s)
    $box = [float]($size - $pad * 2)
    $rad = [float](104 * $s)

    # Royal Amethyst background
    Fill-GradRoundRect $g $pad $pad $box $box $rad '#1E1B4B' '#4C1D95' 135
    Draw-StrokeRoundRect $g $pad $pad $box $box $rad (C '#A78BFA' 90) ([Math]::Max(1.0, 5 * $s))
    Draw-GlowCircle $g (256 * $s) (256 * $s) (150 * $s) '#38BDF8' 50

    # Floating widget cards
    Fill-GradRoundRect $g (86 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) '#312E81' '#4338CA' 135
    Draw-StrokeRoundRect $g (86 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) (C '#818CF8' 150) ([Math]::Max(1.0, 4 * $s))
    Fill-SolidRoundRect $g (108 * $s) (132 * $s) (62 * $s) (14 * $s) (7 * $s) (C '#38BDF8')

    Fill-GradRoundRect $g (282 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) '#164E63' '#0E7490' 135
    Draw-StrokeRoundRect $g (282 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) (C '#22D3EE' 150) ([Math]::Max(1.0, 4 * $s))
    Fill-SolidRoundRect $g (304 * $s) (132 * $s) (84 * $s) (14 * $s) (7 * $s) (C '#34D399')

    # Center Floating Pill (Mic + Mouse)
    Fill-SolidRoundRect $g (88 * $s) (208 * $s) (336 * $s) (112 * $s) (56 * $s) (C '#090D16' 245)
    Draw-GradStrokeRoundRect $g (88 * $s) (208 * $s) (336 * $s) (112 * $s) (56 * $s) '#22D3EE' '#F472B6' ([Math]::Max(1.5, 10 * $s)) 0

    # Left Half: Mic circle + capsule
    $mb = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(108 * $s, 224 * $s, 80 * $s, 80 * $s), (C '#22D3EE'), (C '#3B82F6'), 135)
    $g.FillEllipse($mb, 108 * $s, 224 * $s, 80 * $s, 80 * $s)
    $mb.Dispose()
    Fill-SolidRoundRect $g (137 * $s) (240 * $s) (22 * $s) (36 * $s) (11 * $s) (C '#FFFFFF')
    $mp = New-Object System.Drawing.Pen((C '#FFFFFF'), ([Math]::Max(1.0, 5 * $s)))
    $g.DrawArc($mp, 129 * $s, 248 * $s, 38 * $s, 34 * $s, 0, 180)
    $g.DrawLine($mp, 148 * $s, 282 * $s, 148 * $s, 292 * $s)
    $mp.Dispose()

    # Center divider
    $dp = New-Object System.Drawing.Pen((C '#475569'), ([Math]::Max(1.0, 4 * $s)))
    $g.DrawLine($dp, 256 * $s, 232 * $s, 256 * $s, 296 * $s)
    $dp.Dispose()

    # Right Half: Mouse Touchpad circle + cursor
    $rb = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(324 * $s, 224 * $s, 80 * $s, 80 * $s), (C '#EC4899'), (C '#8B5CF6'), 135)
    $g.FillEllipse($rb, 324 * $s, 224 * $s, 80 * $s, 80 * $s)
    $rb.Dispose()
    $mc = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(350 * $s, 240 * $s),
        [System.Drawing.PointF]::new(350 * $s, 286 * $s),
        [System.Drawing.PointF]::new(363 * $s, 274 * $s),
        [System.Drawing.PointF]::new(376 * $s, 290 * $s),
        [System.Drawing.PointF]::new(385 * $s, 282 * $s),
        [System.Drawing.PointF]::new(372 * $s, 266 * $s),
        [System.Drawing.PointF]::new(388 * $s, 262 * $s)
    )
    $mcb = New-Object System.Drawing.SolidBrush((C '#FFFFFF'))
    $g.FillPolygon($mcb, $mc)
    $mcb.Dispose()

    # Bottom indicator pill
    Fill-GradRoundRect $g (164 * $s) (356 * $s) (184 * $s) (48 * $s) (24 * $s) '#312E81' '#6D28D9' 0
    Draw-StrokeRoundRect $g (164 * $s) (356 * $s) (184 * $s) (48 * $s) (24 * $s) (C '#C4B5FD' 160) ([Math]::Max(1.0, 4 * $s))
    Fill-SolidRoundRect $g (198 * $s) (374 * $s) (116 * $s) (12 * $s) (6 * $s) (C '#E0E7FF')

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($sz in $sizes) { , (New-IconPng $sz) }

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]; $len = $images[$i].Length
    $dim = if ($sz -ge 256) { 0 } else { $sz }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
    $offset += $len
}
foreach ($img in $images) { $bw.Write([byte[]]$img) }
$bw.Close()
"icon written: $out ($((Get-Item $out).Length) bytes)"