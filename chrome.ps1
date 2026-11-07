# Opens page.html in Chrome tabs – the last one shown, the rest in the background – then samples every
# Chrome renderer's CPU each 10s and ends on a `repro:` verdict line
param([int] $Hidden = 6, [int] $Svgs = 30, [int] $Seconds = 900, [string] $Switch = '', [string] $Out = 'results')
$ErrorActionPreference = 'Stop'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if(!$chrome) { throw 'Chrome not found' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$label = 'chrome-h' + $Hidden + '-s' + $Svgs + $(if($Switch) { '-' + ($Switch -replace '[^A-Za-z0-9]+', '_') } else { '' })
$log = Join-Path $Out ($label + '.log')
function Write-Log([string] $text) { $line = (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ' ' + $text; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

$page = ([Uri] (Join-Path (Get-Location) 'page.html')).AbsoluteUri
$urls = 0..$Hidden | ForEach-Object { $page + '?svgs=' + $Svgs + '&kick=3&tab=' + $_ }
$profile = Join-Path $env:RUNNER_TEMP ('chrome-' + $label)
$arguments = @('--user-data-dir="' + $profile + '"', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--start-maximized') + $(if($Switch) { @('--' + $Switch) } else { @() }) + $urls
$version = (Get-Item $chrome).VersionInfo.ProductVersion
Write-Log ('Chrome ' + $version + ' on Windows ' + [Environment]::OSVersion.Version + ', ' + [Environment]::ProcessorCount + ' logical cores, ' + $Hidden + ' background tabs, ' + $Svgs + ' SVGs, switch ' + $(if($Switch) { $Switch } else { 'none' }))
Start-Process -FilePath $chrome -ArgumentList $arguments
Start-Sleep -Seconds 30

function Read-Renderers {
	$map = @{}
	foreach($p in Get-CimInstance Win32_Process -Filter "Name='chrome.exe'") {
		if($p.CommandLine -match '--type=renderer' -and $p.CommandLine -notmatch 'extension-process') {
			try { $map[$p.ProcessId] = (Get-Process -Id $p.ProcessId).TotalProcessorTime.TotalSeconds } catch { }
		}
	}
	$map
}
$samples = @()
$last = Read-Renderers
$lastAt = [Diagnostics.Stopwatch]::StartNew()
Write-Log ('renderers ' + $last.Count)
$began = Get-Date
while(((Get-Date) - $began).TotalSeconds -lt $Seconds) {
	Start-Sleep -Seconds 10
	$now = Read-Renderers
	$secs = $lastAt.Elapsed.TotalSeconds
	$lastAt.Restart()
	$pcts = @($now.Keys | Where-Object { $last.ContainsKey($_) } | ForEach-Object { [math]::Round(($now[$_] - $last[$_]) / $secs * 100) } | Sort-Object -Descending)
	$samples += , $pcts
	Write-Log ('t=' + [math]::Round(((Get-Date) - $began).TotalSeconds) + 's renderers ' + (($pcts | ForEach-Object { '' + $_ + '%' }) -join ' '))
	$last = $now
}
# Per rank (busiest first), averaged over the last third – index loops, as the pipeline flattens nested arrays
$count = $samples.Count
$from = [math]::Max(0, $count - [math]::Max(1, [math]::Floor($count / 3)))
$width = 0
for($k = $from; $k -lt $count; $k++) { $width = [math]::Max($width, $samples[$k].Count) }
$averages = @()
for($i = 0; $i -lt $width; $i++) {
	$sum = 0
	for($k = $from; $k -lt $count; $k++) { if($samples[$k].Count -gt $i) { $sum += $samples[$k][$i] } }
	$averages += [math]::Round($sum / [math]::Max(1, $count - $from))
}
$spinning = @($averages | Where-Object { $_ -ge 15 }).Count
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Log ('repro: ' + $(if($spinning) { 'spin' } else { 'quiet' }) + ' – ' + $spinning + ' renderers at 15%+ over the last third (' + ($averages -join '/') + '%, busiest first)')
