<#
.SYNOPSIS
  Generates 10 modern icon candidates (512x512 PNG + multi-size Windows .ico + 5x2 comparison gallery)
  for PhoneBox Android app and PhoneBoxAgent.exe.
  Output: docs/icon-candidates/
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot
$outDir = Join-Path $root 'docs\icon-candidates'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

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

function Draw-GradStrokeRoundRect($g, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r, [string]$hex1, [string]$hex2, [float]$width, [float]$angle = 45) {
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

function Draw-GlowCircle($g, [float]$cx, [float]$cy, [float]$radius, [string]$hex, [int]$maxAlpha = 70) {
    for ($i = 4; $i -ge 1; $i--) {
        $rr = [float]($radius * (0.5 + 0.28 * $i))
        $a = [int]($maxAlpha / $i)
        $b = New-Object System.Drawing.SolidBrush((C $hex $a))
        $g.FillEllipse($b, $cx - $rr, $cy - $rr, $rr * 2, $rr * 2)
        $b.Dispose()
    }
}

function Draw-Sparkle($g, [float]$cx, [float]$cy, [float]$r, [System.Drawing.Color]$color) {
    $inner = [float]($r * 0.28)
    $pts = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($cx, $cy - $r),
        [System.Drawing.PointF]::new($cx + $inner, $cy - $inner),
        [System.Drawing.PointF]::new($cx + $r, $cy),
        [System.Drawing.PointF]::new($cx + $inner, $cy + $inner),
        [System.Drawing.PointF]::new($cx, $cy + $r),
        [System.Drawing.PointF]::new($cx - $inner, $cy + $inner),
        [System.Drawing.PointF]::new($cx - $r, $cy),
        [System.Drawing.PointF]::new($cx - $inner, $cy - $inner)
    )
    $b = New-Object System.Drawing.SolidBrush($color)
    $g.FillPolygon($b, $pts)
    $b.Dispose()
}

function Render-Icon([int]$id, [int]$size) {
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

    switch ($id) {
        1 {
            # #01 - Desk Panel Pro (Upgraded Midnight Display + Vibrant Telemetry Bars)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#0B1220' '#18243D' 135
            Draw-StrokeRoundRect $g $pad $pad $box $box $rad (C '#38BDF8' 55) ([Math]::Max(1.0, 4 * $s))
            Draw-GlowCircle $g (256 * $s) (220 * $s) (130 * $s) '#2DD4BF' 42

            # Screen body & glossy frame
            Fill-SolidRoundRect $g (86 * $s) (112 * $s) (340 * $s) (236 * $s) (34 * $s) (C '#070B14' 230)
            Draw-GradStrokeRoundRect $g (86 * $s) (112 * $s) (340 * $s) (236 * $s) (34 * $s) '#E2E8F0' '#38BDF8' ([Math]::Max(1.5, 16 * $s)) 45

            # Equalizer bars
            Fill-GradRoundRect $g (138 * $s) (240 * $s) (42 * $s) (64 * $s) (10 * $s) '#2DD4BF' '#0EA5E9' 90
            Fill-GradRoundRect $g (198 * $s) (180 * $s) (42 * $s) (124 * $s) (10 * $s) '#84CC16' '#22C55E' 90
            Fill-GradRoundRect $g (258 * $s) (208 * $s) (42 * $s) (96 * $s) (10 * $s) '#A78BFA' '#6366F1' 90

            # Clock / status orb
            Draw-GlowCircle $g (354 * $s) (212 * $s) (38 * $s) '#F59E0B' 80
            $orb = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(326 * $s, 184 * $s, 56 * $s, 56 * $s), (C '#FDE047'), (C '#F97316'), 135)
            $g.FillEllipse($orb, 326 * $s, 184 * $s, 56 * $s, 56 * $s)
            $orb.Dispose()

            # Metallic stand
            Fill-GradRoundRect $g (232 * $s) (348 * $s) (48 * $s) (40 * $s) (8 * $s) '#CBD5E1' '#64748B' 90
            Fill-GradRoundRect $g (168 * $s) (384 * $s) (176 * $s) (24 * $s) (12 * $s) '#F1F5F9' '#94A3B8' 0
        }
        2 {
            # #02 - Cyber Control Deck (2x2 Illuminated Stream Keys)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#090D16' '#111827' 145
            Draw-GradStrokeRoundRect $g $pad $pad $box $box $rad '#06B6D4' '#8B5CF6' ([Math]::Max(1.2, 6 * $s)) 45

            # Outer bezel
            Fill-SolidRoundRect $g (76 * $s) (76 * $s) (360 * $s) (360 * $s) (56 * $s) (C '#0F172A' 240)
            Draw-StrokeRoundRect $g (76 * $s) (76 * $s) (360 * $s) (360 * $s) (56 * $s) (C '#334155' 180) ([Math]::Max(1.0, 5 * $s))

            # Tile 1 (TL): Cyan Touchpad Cursor
            Fill-GradRoundRect $g (104 * $s) (104 * $s) (140 * $s) (140 * $s) (30 * $s) '#083344' '#0E7490' 135
            Draw-StrokeRoundRect $g (104 * $s) (104 * $s) (140 * $s) (140 * $s) (30 * $s) (C '#22D3EE' 190) ([Math]::Max(1.0, 4 * $s))
            $cur = [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(146 * $s, 134 * $s),
                [System.Drawing.PointF]::new(146 * $s, 210 * $s),
                [System.Drawing.PointF]::new(168 * $s, 190 * $s),
                [System.Drawing.PointF]::new(190 * $s, 216 * $s),
                [System.Drawing.PointF]::new(204 * $s, 204 * $s),
                [System.Drawing.PointF]::new(182 * $s, 178 * $s),
                [System.Drawing.PointF]::new(210 * $s, 172 * $s)
            )
            $wb = New-Object System.Drawing.SolidBrush((C '#ECFEFF'))
            $g.FillPolygon($wb, $cur)
            $wb.Dispose()

            # Tile 2 (TR): Purple AI Sparkle
            Fill-GradRoundRect $g (268 * $s) (104 * $s) (140 * $s) (140 * $s) (30 * $s) '#2E1065' '#6D28D9' 135
            Draw-StrokeRoundRect $g (268 * $s) (104 * $s) (140 * $s) (140 * $s) (30 * $s) (C '#C4B5FD' 190) ([Math]::Max(1.0, 4 * $s))
            Draw-Sparkle $g (338 * $s) (174 * $s) (42 * $s) (C '#F5F3FF')

            # Tile 3 (BL): Emerald Audio Bars
            Fill-GradRoundRect $g (104 * $s) (268 * $s) (140 * $s) (140 * $s) (30 * $s) '#064E3B' '#059669' 135
            Draw-StrokeRoundRect $g (104 * $s) (268 * $s) (140 * $s) (140 * $s) (30 * $s) (C '#34D399' 190) ([Math]::Max(1.0, 4 * $s))
            Fill-SolidRoundRect $g (134 * $s) (342 * $s) (18 * $s) (36 * $s) (6 * $s) (C '#ECFDF5')
            Fill-SolidRoundRect $g (164 * $s) (304 * $s) (18 * $s) (74 * $s) (6 * $s) (C '#ECFDF5')
            Fill-SolidRoundRect $g (194 * $s) (324 * $s) (18 * $s) (54 * $s) (6 * $s) (C '#ECFDF5')

            # Tile 4 (BR): Amber Play/Control
            Fill-GradRoundRect $g (268 * $s) (268 * $s) (140 * $s) (140 * $s) (30 * $s) '#78350F' '#D97706' 135
            Draw-StrokeRoundRect $g (268 * $s) (268 * $s) (140 * $s) (140 * $s) (30 * $s) (C '#FCD34D' 190) ([Math]::Max(1.0, 4 * $s))
            $play = [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(316 * $s, 304 * $s),
                [System.Drawing.PointF]::new(316 * $s, 372 * $s),
                [System.Drawing.PointF]::new(374 * $s, 338 * $s)
            )
            $pb = New-Object System.Drawing.SolidBrush((C '#FFFBEB'))
            $g.FillPolygon($pb, $play)
            $pb.Dispose()
        }
        3 {
            # #03 - Realme Edge & Liquid Wave (Neon Edge Phone + 5-Band FFT Audio)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#070913' '#140F29' 135
            Draw-GlowCircle $g (190 * $s) (256 * $s) (120 * $s) '#06B6D4' 48
            Draw-GlowCircle $g (325 * $s) (256 * $s) (120 * $s) '#EC4899' 48

            # Glowing Edge Phone frame (vertical rounded bezel with rainbow gradient edge)
            Fill-SolidRoundRect $g (136 * $s) (64 * $s) (240 * $s) (384 * $s) (48 * $s) (C '#090D18' 245)
            Draw-GradStrokeRoundRect $g (136 * $s) (64 * $s) (240 * $s) (384 * $s) (48 * $s) '#22D3EE' '#EC4899' ([Math]::Max(1.8, 16 * $s)) 35
            Draw-GradStrokeRoundRect $g (152 * $s) (80 * $s) (208 * $s) (352 * $s) (36 * $s) '#38BDF8' '#F59E0B' ([Math]::Max(0.8, 4 * $s)) 135

            # Speaker pill notch
            Fill-SolidRoundRect $g (224 * $s) (94 * $s) (64 * $s) (12 * $s) (6 * $s) (C '#64748B' 200)

            # 5 Liquid FFT spectrum bars centered
            $bars = @(
                @{ x = 176; h = 92; c1 = '#22D3EE'; c2 = '#3B82F6' },
                @{ x = 210; h = 156; c1 = '#34D399'; c2 = '#06B6D4' },
                @{ x = 244; h = 204; c1 = '#A78BFA'; c2 = '#EC4899' },
                @{ x = 278; h = 138; c1 = '#F472B6'; c2 = '#F59E0B' },
                @{ x = 312; h = 84; c1 = '#FBBF24'; c2 = '#EF4444' }
            )
            foreach ($b in $bars) {
                $by = [float](256 - $b.h / 2.0)
                Fill-GradRoundRect $g ($b.x * $s) ($by * $s) (24 * $s) ($b.h * $s) (12 * $s) $b.c1 $b.c2 90
            }

            # Bottom dock bar
            Fill-GradRoundRect $g (196 * $s) (398 * $s) (120 * $s) (12 * $s) (6 * $s) '#22D3EE' '#EC4899' 0
        }
        4 {
            # #04 - PC <-> Phone Quantum Bridge (Desktop + Landscape Phone + Data Arc)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#0A192F' '#0F2942' 135
            Draw-GlowCircle $g (256 * $s) (256 * $s) (145 * $s) '#14B8A6' 45

            # Back Desktop Monitor
            Fill-SolidRoundRect $g (76 * $s) (96 * $s) (268 * $s) (180 * $s) (24 * $s) (C '#0F172A' 240)
            Draw-StrokeRoundRect $g (76 * $s) (96 * $s) (268 * $s) (180 * $s) (24 * $s) (C '#94A3B8' 220) ([Math]::Max(1.2, 12 * $s))
            Fill-SolidRoundRect $g (190 * $s) (276 * $s) (40 * $s) (30 * $s) (4 * $s) (C '#94A3B8' 220)
            Fill-SolidRoundRect $g (146 * $s) (304 * $s) (128 * $s) (14 * $s) (7 * $s) (C '#CBD5E1' 230)

            # Data links inside PC monitor
            Fill-GradRoundRect $g (108 * $s) (136 * $s) (110 * $s) (18 * $s) (9 * $s) '#38BDF8' '#0EA5E9' 0
            Fill-GradRoundRect $g (108 * $s) (170 * $s) (76 * $s) (18 * $s) (9 * $s) '#2DD4BF' '#10B981' 0
            Fill-GradRoundRect $g (108 * $s) (204 * $s) (94 * $s) (18 * $s) (9 * $s) '#818CF8' '#6366F1' 0

            # Front Landscape Phone Panel
            Fill-SolidRoundRect $g (184 * $s) (238 * $s) (256 * $s) (164 * $s) (28 * $s) (C '#020617' 250)
            Draw-GradStrokeRoundRect $g (184 * $s) (238 * $s) (256 * $s) (164 * $s) (28 * $s) '#2DD4BF' '#38BDF8' ([Math]::Max(1.5, 13 * $s)) 45

            # Bridge signal arcs (top right)
            foreach ($r in @(34, 58, 82)) {
                $pen = New-Object System.Drawing.Pen((C '#2DD4BF' 220), ([Math]::Max(1.2, 8 * $s)))
                $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
                $g.DrawArc($pen, (364 - $r) * $s, (152 - $r) * $s, (2 * $r) * $s, (2 * $r) * $s, -80, 75)
                $pen.Dispose()
            }

            # Phone mini widgets
            Fill-GradRoundRect $g (214 * $s) (274 * $s) (84 * $s) (92 * $s) (14 * $s) '#0D9488' '#14B8A6' 135
            Fill-GradRoundRect $g (316 * $s) (274 * $s) (94 * $s) (40 * $s) (12 * $s) '#0284C7' '#38BDF8' 0
            Fill-GradRoundRect $g (316 * $s) (326 * $s) (94 * $s) (40 * $s) (12 * $s) '#4F46E5' '#818CF8' 0
        }
        5 {
            # #05 - AI Voice & Mic Studio (Glowing Condenser Mic + Waves + AI Star)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#150B30' '#2E1065' 135
            Draw-GlowCircle $g (256 * $s) (238 * $s) (150 * $s) '#A855F7' 60

            # Concentric voice waves
            foreach ($wr in @(112, 152)) {
                $p1 = New-Object System.Drawing.Pen((C '#C084FC' 130), ([Math]::Max(1.2, 9 * $s)))
                $p1.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                $p1.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
                $g.DrawArc($p1, (256 - $wr) * $s, (220 - $wr) * $s, (2 * $wr) * $s, (2 * $wr) * $s, 145, 70)
                $g.DrawArc($p1, (256 - $wr) * $s, (220 - $wr) * $s, (2 * $wr) * $s, (2 * $wr) * $s, -35, 70)
                $p1.Dispose()
            }

            # Mic capsule
            Fill-GradRoundRect $g (208 * $s) (118 * $s) (96 * $s) (164 * $s) (48 * $s) '#F0ABFC' '#38BDF8' 135
            # Mic grille lines
            $gp = New-Object System.Drawing.Pen((C '#1E1B4B' 130), ([Math]::Max(1.0, 6 * $s)))
            $gp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $gp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawLine($gp, 230 * $s, 168 * $s, 282 * $s, 168 * $s)
            $g.DrawLine($gp, 230 * $s, 196 * $s, 282 * $s, 196 * $s)
            $g.DrawLine($gp, 230 * $s, 224 * $s, 282 * $s, 224 * $s)
            $gp.Dispose()

            # Mic cradle U-arc & base
            $upen = New-Object System.Drawing.Pen((C '#E2E8F0' 235), ([Math]::Max(1.5, 16 * $s)))
            $upen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $upen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawArc($upen, 174 * $s, 164 * $s, 164 * $s, 152 * $s, 0, 180)
            $g.DrawLine($upen, 256 * $s, 316 * $s, 256 * $s, 386 * $s)
            $g.DrawLine($upen, 200 * $s, 386 * $s, 312 * $s, 386 * $s)
            $upen.Dispose()

            # AI 4-point sparkle badge
            Draw-Sparkle $g (368 * $s) (128 * $s) (36 * $s) (C '#38BDF8')
            Draw-Sparkle $g (142 * $s) (142 * $s) (20 * $s) (C '#F472B6')
        }
        6 {
            # #06 - Precision Touchpad & Cursor (Grid Surface + Ripple + Cursor)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#06141B' '#0B252C' 135
            Draw-GradStrokeRoundRect $g $pad $pad $box $box $rad '#10B981' '#06B6D4' ([Math]::Max(1.2, 6 * $s)) 45

            # Touchpad surface
            Fill-SolidRoundRect $g (74 * $s) (94 * $s) (364 * $s) (324 * $s) (42 * $s) (C '#0D1F26' 240)
            Draw-StrokeRoundRect $g (74 * $s) (94 * $s) (364 * $s) (324 * $s) (42 * $s) (C '#2DD4BF' 150) ([Math]::Max(1.2, 8 * $s))

            # Subtle coordinate grid
            $gridPen = New-Object System.Drawing.Pen((C '#2DD4BF' 42), ([Math]::Max(0.8, 3 * $s)))
            foreach ($gx in @(165, 256, 347)) { $g.DrawLine($gridPen, $gx * $s, 114 * $s, $gx * $s, 342 * $s) }
            foreach ($gy in @(176, 256, 336)) { $g.DrawLine($gridPen, 94 * $s, $gy * $s, 418 * $s, $gy * $s) }
            $gridPen.Dispose()

            # Bottom left/right click divider
            $divPen = New-Object System.Drawing.Pen((C '#2DD4BF' 120), ([Math]::Max(1.0, 5 * $s)))
            $g.DrawLine($divPen, 94 * $s, 354 * $s, 418 * $s, 354 * $s)
            $g.DrawLine($divPen, 256 * $s, 354 * $s, 256 * $s, 404 * $s)
            $divPen.Dispose()

            # Touch ripple + bright cursor
            Draw-GlowCircle $g (210 * $s) (186 * $s) (70 * $s) '#10B981' 65
            $rp = New-Object System.Drawing.Pen((C '#34D399' 170), ([Math]::Max(1.0, 6 * $s)))
            $g.DrawEllipse($rp, 168 * $s, 144 * $s, 84 * $s, 84 * $s)
            $rp.Dispose()

            $cur = [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(208 * $s, 164 * $s),
                [System.Drawing.PointF]::new(208 * $s, 316 * $s),
                [System.Drawing.PointF]::new(252 * $s, 276 * $s),
                [System.Drawing.PointF]::new(294 * $s, 326 * $s),
                [System.Drawing.PointF]::new(320 * $s, 304 * $s),
                [System.Drawing.PointF]::new(278 * $s, 254 * $s),
                [System.Drawing.PointF]::new(330 * $s, 244 * $s)
            )
            $cb = New-Object System.Drawing.SolidBrush((C '#ECFDF5'))
            $cp = New-Object System.Drawing.Pen((C '#059669'), ([Math]::Max(1.0, 6 * $s)))
            $cp.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $g.FillPolygon($cb, $cur)
            $g.DrawPolygon($cp, $cur)
            $cb.Dispose(); $cp.Dispose()
        }
        7 {
            # #07 - 3D Dock Station (Phone on Glowing Desk Dock + CPU Curve)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#111827' '#1F2937' 135
            Draw-GlowCircle $g (256 * $s) (368 * $s) (125 * $s) '#38BDF8' 65

            # Dock base
            Fill-GradRoundRect $g (104 * $s) (348 * $s) (304 * $s) (52 * $s) (22 * $s) '#475569' '#1E293B' 90
            # Dock LED strip
            Fill-GradRoundRect $g (140 * $s) (380 * $s) (232 * $s) (10 * $s) (5 * $s) '#22D3EE' '#818CF8' 0

            # Tilted / crisp landscape tablet-phone screen on dock
            Fill-SolidRoundRect $g (90 * $s) (112 * $s) (332 * $s) (232 * $s) (32 * $s) (C '#020617' 245)
            Draw-GradStrokeRoundRect $g (90 * $s) (112 * $s) (332 * $s) (232 * $s) (32 * $s) '#E2E8F0' '#64748B' ([Math]::Max(1.5, 13 * $s)) 90

            # Top clock pills & CPU line wave
            Fill-GradRoundRect $g (124 * $s) (144 * $s) (132 * $s) (64 * $s) (14 * $s) '#1E293B' '#334155' 90
            Fill-GradRoundRect $g (272 * $s) (144 * $s) (116 * $s) (64 * $s) (14 * $s) '#0F766E' '#14B8A6' 135
            Fill-SolidRoundRect $g (142 * $s) (166 * $s) (42 * $s) (20 * $s) (6 * $s) (C '#F8FAFC')
            Fill-SolidRoundRect $g (196 * $s) (166 * $s) (42 * $s) (20 * $s) (6 * $s) (C '#38BDF8')

            # Telemetry chart card
            Fill-SolidRoundRect $g (124 * $s) (226 * $s) (264 * $s) (86 * $s) (16 * $s) (C '#0F172A' 240)
            $wave = [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(140 * $s, 290 * $s),
                [System.Drawing.PointF]::new(182 * $s, 256 * $s),
                [System.Drawing.PointF]::new(220 * $s, 276 * $s),
                [System.Drawing.PointF]::new(268 * $s, 240 * $s),
                [System.Drawing.PointF]::new(318 * $s, 268 * $s),
                [System.Drawing.PointF]::new(368 * $s, 244 * $s)
            )
            $wp = New-Object System.Drawing.Pen((C '#38BDF8'), ([Math]::Max(1.5, 9 * $s)))
            $wp.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $wp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $wp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawLines($wp, $wave)
            $wp.Dispose()
        }
        8 {
            # #08 - Monogram PB Pulse (Modern Geometric PB + Signal Pulse on Coral Sunset)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#E11D48' '#F59E0B' 135
            Draw-StrokeRoundRect $g $pad $pad $box $box $rad (C '#FFFBEB' 75) ([Math]::Max(1.0, 5 * $s))

            # Dark inner squircle badge for crisp high contrast
            Fill-SolidRoundRect $g (62 * $s) (62 * $s) (388 * $s) (388 * $s) (76 * $s) (C '#110915' 215)

            # Geometric "P" (left)
            $penP = New-Object System.Drawing.Pen((C '#FFF1F2'), ([Math]::Max(2.0, 26 * $s)))
            $penP.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $penP.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $penP.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $g.DrawLine($penP, 146 * $s, 344 * $s, 146 * $s, 166 * $s)
            $g.DrawArc($penP, 146 * $s, 166 * $s, 102 * $s, 96 * $s, -90, 180)
            $g.DrawLine($penP, 146 * $s, 262 * $s, 198 * $s, 262 * $s)
            $penP.Dispose()

            # Geometric "B" (right) in amber/gold
            $penB = New-Object System.Drawing.Pen((C '#FBBF24'), ([Math]::Max(2.0, 26 * $s)))
            $penB.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $penB.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $penB.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $g.DrawLine($penB, 276 * $s, 344 * $s, 276 * $s, 166 * $s)
            $g.DrawArc($penB, 276 * $s, 166 * $s, 92 * $s, 86 * $s, -90, 180)
            $g.DrawArc($penB, 276 * $s, 252 * $s, 100 * $s, 92 * $s, -90, 180)
            $g.DrawLine($penB, 276 * $s, 252 * $s, 326 * $s, 252 * $s)
            $g.DrawLine($penB, 276 * $s, 344 * $s, 326 * $s, 344 * $s)
            $penB.Dispose()

            # Pulse line across bottom
            $pulse = [System.Drawing.PointF[]]@(
                [System.Drawing.PointF]::new(112 * $s, 392 * $s),
                [System.Drawing.PointF]::new(196 * $s, 392 * $s),
                [System.Drawing.PointF]::new(222 * $s, 362 * $s),
                [System.Drawing.PointF]::new(252 * $s, 412 * $s),
                [System.Drawing.PointF]::new(280 * $s, 374 * $s),
                [System.Drawing.PointF]::new(304 * $s, 392 * $s),
                [System.Drawing.PointF]::new(400 * $s, 392 * $s)
            )
            $pp = New-Object System.Drawing.Pen((C '#FB7185'), ([Math]::Max(1.2, 9 * $s)))
            $pp.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $pp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $pp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawLines($pp, $pulse)
            $pp.Dispose()
        }
        9 {
            # #09 - Hardware Telemetry Gauge (Glowing Speedometer Arc + Phone Core)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#09110E' '#0F241D' 135
            Draw-GlowCircle $g (256 * $s) (256 * $s) (150 * $s) '#76B900' 48

            # Gauge background track
            $trackPen = New-Object System.Drawing.Pen((C '#1E293B' 220), ([Math]::Max(2.0, 28 * $s)))
            $trackPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $trackPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawArc($trackPen, 92 * $s, 92 * $s, 328 * $s, 328 * $s, 135, 270)
            $trackPen.Dispose()

            # Active NVIDIA-green -> Teal arc
            $arcBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(76 * $s, 76 * $s, 360 * $s, 360 * $s), (C '#2DD4BF'), (C '#84CC16'), 0)
            $arcPen = New-Object System.Drawing.Pen($arcBrush, ([Math]::Max(2.0, 28 * $s)))
            $arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $g.DrawArc($arcPen, 92 * $s, 92 * $s, 328 * $s, 328 * $s, 135, 205)
            $arcPen.Dispose()
            $arcBrush.Dispose()

            # Center phone icon
            Fill-SolidRoundRect $g (196 * $s) (156 * $s) (120 * $s) (198 * $s) (24 * $s) (C '#0B1320' 250)
            Draw-StrokeRoundRect $g (196 * $s) (156 * $s) (120 * $s) (198 * $s) (24 * $s) (C '#E2E8F0' 235) ([Math]::Max(1.2, 10 * $s))
            Fill-GradRoundRect $g (216 * $s) (204 * $s) (22 * $s) (86 * $s) (6 * $s) '#2DD4BF' '#14B8A6' 90
            Fill-GradRoundRect $g (245 * $s) (184 * $s) (22 * $s) (106 * $s) (6 * $s) '#84CC16' '#22C55E' 90
            Fill-GradRoundRect $g (274 * $s) (224 * $s) (22 * $s) (66 * $s) (6 * $s) '#F59E0B' '#EF4444' 90

            # Bottom telemetry badge
            Fill-SolidRoundRect $g (204 * $s) (386 * $s) (104 * $s) (28 * $s) (14 * $s) (C '#84CC16' 230)
        }
        10 {
            # #10 - Floating Pill Command (Dual Floating Mic+Mouse Pill + Orbiting Widgets)
            Fill-GradRoundRect $g $pad $pad $box $box $rad '#1E1B4B' '#4C1D95' 135
            Draw-StrokeRoundRect $g $pad $pad $box $box $rad (C '#A78BFA' 90) ([Math]::Max(1.0, 5 * $s))
            Draw-GlowCircle $g (256 * $s) (256 * $s) (150 * $s) '#38BDF8' 50

            # Floating widget cards around the center pill
            Fill-GradRoundRect $g (86 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) '#312E81' '#4338CA' 135
            Draw-StrokeRoundRect $g (86 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) (C '#818CF8' 150) ([Math]::Max(1.0, 4 * $s))
            Fill-SolidRoundRect $g (108 * $s) (132 * $s) (62 * $s) (14 * $s) (7 * $s) (C '#38BDF8')

            Fill-GradRoundRect $g (282 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) '#164E63' '#0E7490' 135
            Draw-StrokeRoundRect $g (282 * $s) (104 * $s) (144 * $s) (78 * $s) (20 * $s) (C '#22D3EE' 150) ([Math]::Max(1.0, 4 * $s))
            Fill-SolidRoundRect $g (304 * $s) (132 * $s) (84 * $s) (14 * $s) (7 * $s) (C '#34D399')

            # Center Floating Pill (Mic + Mouse)
            Fill-SolidRoundRect $g (88 * $s) (208 * $s) (336 * $s) (112 * $s) (56 * $s) (C '#090D16' 245)
            Draw-GradStrokeRoundRect $g (88 * $s) (208 * $s) (336 * $s) (112 * $s) (56 * $s) '#22D3EE' '#F472B6' ([Math]::Max(1.5, 10 * $s)) 0

            # Left Half: Active Mic circle + capsule
            $mb = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.RectangleF]::new(108 * $s, 224 * $s, 80 * $s, 80 * $s), (C '#22D3EE'), (C '#3B82F6'), 135)
            $g.FillEllipse($mb, 108 * $s, 224 * $s, 80 * $s, 80 * $s)
            $mb.Dispose()
            Fill-SolidRoundRect $g (137 * $s) (240 * $s) (22 * $s) (36 * $s) (11 * $s) (C '#FFFFFF')
            $mp = New-Object System.Drawing.Pen((C '#FFFFFF'), ([Math]::Max(1.0, 5 * $s)))
            $g.DrawArc($mp, 129 * $s, 248 * $s, 38 * $s, 34 * $s, 0, 180)
            $g.DrawLine($mp, 148 * $s, 282 * $s, 148 * $s, 292 * $s)
            $mp.Dispose()

            # Divider & Right Half: Mouse Touchpad button
            $dp = New-Object System.Drawing.Pen((C '#475569'), ([Math]::Max(1.0, 4 * $s)))
            $g.DrawLine($dp, 256 * $s, 232 * $s, 256 * $s, 296 * $s)
            $dp.Dispose()

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

            # Bottom floating indicator pill
            Fill-GradRoundRect $g (164 * $s) (356 * $s) (184 * $s) (48 * $s) (24 * $s) '#312E81' '#6D28D9' 0
            Draw-StrokeRoundRect $g (164 * $s) (356 * $s) (184 * $s) (48 * $s) (24 * $s) (C '#C4B5FD' 160) ([Math]::Max(1.0, 4 * $s))
            Fill-SolidRoundRect $g (198 * $s) (374 * $s) (116 * $s) (12 * $s) (6 * $s) (C '#E0E7FF')
        }
    }

    $g.Dispose()
    return $bmp
}

function Write-Ico([int]$id, [string]$icoPath) {
    $sizes = 16, 24, 32, 48, 64, 128, 256
    $pngChunks = foreach ($sz in $sizes) {
        $bmp = Render-Icon $id $sz
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        , $ms.ToArray()
    }
    $fs = [System.IO.File]::Create($icoPath)
    $bw = New-Object System.IO.BinaryWriter $fs
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $sz = $sizes[$i]; $len = $pngChunks[$i].Length
        $dim = if ($sz -ge 256) { 0 } else { $sz }
        $bw.Write([byte]$dim); $bw.Write([byte]$dim)
        $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
        $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
        $offset += $len
    }
    foreach ($chunk in $pngChunks) { $bw.Write([byte[]]$chunk) }
    $bw.Close()
}

$catalog = @(
    @{ Id = 1;  Name = 'Desk Panel Pro' },
    @{ Id = 2;  Name = 'Cyber Control Deck' },
    @{ Id = 3;  Name = 'Realme Edge Wave' },
    @{ Id = 4;  Name = 'Quantum Bridge' },
    @{ Id = 5;  Name = 'AI Voice Studio' },
    @{ Id = 6;  Name = 'Touchpad Cursor' },
    @{ Id = 7;  Name = '3D Dock Station' },
    @{ Id = 8;  Name = 'Monogram PB Pulse' },
    @{ Id = 9;  Name = 'Telemetry Gauge' },
    @{ Id = 10; Name = 'Floating Pill Pro' }
)

foreach ($item in $catalog) {
    $num = '{0:D2}' -f $item.Id
    $pngPath = Join-Path $outDir "icon-$num.png"
    $icoPath = Join-Path $outDir "icon-$num.ico"
    $bmp = Render-Icon $item.Id 512
    $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Ico $item.Id $icoPath
}

# Build 5x2 gallery sheet
$gw = 1660; $gh = 800
$gal = New-Object System.Drawing.Bitmap $gw, $gh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gg = [System.Drawing.Graphics]::FromImage($gal)
$gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$gg.Clear((C '#070B12'))

$titleFont = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
$subFont   = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Regular)
$badgeFont = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$cardFont  = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)

$tb = New-Object System.Drawing.SolidBrush((C '#F8FAFC'))
$sb = New-Object System.Drawing.SolidBrush((C '#94A3B8'))
$gg.DrawString('PhoneBox App & EXE Icon Candidates (#01 - #10)', $titleFont, $tb, 36, 22)
$gg.DrawString('512x512 PNG + Multi-Size Windows .ICO (16..256 px) — docs/icon-candidates/', $subFont, $sb, 38, 60)

$cardW = 304; $cardH = 330; $gapX = 20; $gapY = 22; $startX = 30; $startY = 100
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center

for ($idx = 0; $idx -lt $catalog.Count; $idx++) {
    $col = $idx % 5
    $row = [int][Math]::Floor($idx / 5.0)
    $cx = [float]($startX + $col * ($cardW + $gapX))
    $cy = [float]($startY + $row * ($cardH + $gapY))

    Fill-GradRoundRect $gg $cx $cy $cardW $cardH 22 '#0F172A' '#131C31' 135
    Draw-StrokeRoundRect $gg $cx $cy $cardW $cardH 22 (C '#334155' 180) 1.5

    $num = '{0:D2}' -f $catalog[$idx].Id
    $iconBmp = Render-Icon $catalog[$idx].Id 220
    $gg.DrawImage($iconBmp, $cx + ($cardW - 220) / 2.0, $cy + 20, 220, 220)
    $iconBmp.Dispose()

    Fill-SolidRoundRect $gg ($cx + 18) ($cy + 252) 50 26 10 (C '#0EA5E9' 45)
    Draw-StrokeRoundRect $gg ($cx + 18) ($cy + 252) 50 26 10 (C '#38BDF8' 180) 1.2
    $bb = New-Object System.Drawing.SolidBrush((C '#7DD3FC'))
    $gg.DrawString("#$num", $badgeFont, $bb, ($cx + 26), ($cy + 256))
    $bb.Dispose()

    $gg.DrawString($catalog[$idx].Name, $cardFont, $tb, ($cx + 76), ($cy + 255))
    $gg.DrawString("icon-$num.ico / .png", $subFont, $sb, ($cx + $cardW / 2.0), ($cy + 292), $sf)
}

$tb.Dispose(); $sb.Dispose(); $sf.Dispose()
$titleFont.Dispose(); $subFont.Dispose(); $badgeFont.Dispose(); $cardFont.Dispose()
$gg.Dispose()

$galPath = Join-Path $outDir 'gallery-10-icons.png'
$gal.Save($galPath, [System.Drawing.Imaging.ImageFormat]::Png)
$gal.Dispose()

"Generated 10 PNG + 10 ICO + gallery in $outDir"
Get-ChildItem $outDir | Select-Object Name, Length
