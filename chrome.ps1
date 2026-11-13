# Opens page.html in a fresh Chrome profile's tabs – one shown, the rest in the background – then samples
# that Chrome's renderers' CPU every 10s and ends on a `repro:` verdict line. Other Chrome windows stay untouched
# -Variations also saves that Chrome's chrome://version/?show-variations-cmd page once sampling ends
param([int] $Hidden = 6, [int] $Svgs = 30, [int] $Seconds = 900, [string] $Switch = '', [string] $Out = 'results', [switch] $Variations)
$ErrorActionPreference = 'Stop'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if(!$chrome) { throw 'Chrome not found' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$label = 'chrome-h' + $Hidden + '-s' + $Svgs + $(if($Switch) { '-' + ($Switch -replace '[^A-Za-z0-9]+', '_') } else { '' })
$log = Join-Path $Out ($label + '.log')
function Write-Log([string] $text) { $line = (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ' ' + $text; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

$page = ([Uri] (Join-Path (Get-Location) 'page.html')).AbsoluteUri
$urls = 0..$Hidden | ForEach-Object { $page + '?svgs=' + $Svgs + '&kick=3&tab=' + $_ }
$profile = Join-Path $(if($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) ('svg-gc-repro-' + $label)
$arguments = @('--user-data-dir="' + $profile + '"', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--start-maximized') + $(if($Switch) { @('--' + $Switch) } else { @() }) + $(if($Variations) { @('--remote-debugging-port=9229') } else { @() }) + $urls
$version = (Get-Item $chrome).VersionInfo.ProductVersion
Write-Log ('Chrome ' + $version + ' on Windows ' + [Environment]::OSVersion.Version + ', ' + [Environment]::ProcessorCount + ' logical cores, ' + $Hidden + ' background tabs, ' + $Svgs + ' SVGs, switch ' + $(if($Switch) { $Switch } else { 'none' }))
# A fresh profile starts a Chrome of its own – only its children get sampled and closed
$browser = Start-Process -FilePath $chrome -ArgumentList $arguments -PassThru
Start-Sleep -Seconds 30

function Read-Renderers {
	$map = @{}
	foreach($p in Get-CimInstance Win32_Process -Filter ("Name='chrome.exe' AND ParentProcessId=" + $browser.Id)) {
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
if($Variations) {
	try {
		$target = Invoke-RestMethod -Method Put -Uri 'http://127.0.0.1:9229/json/new?chrome://version/?show-variations-cmd'
		Start-Sleep -Seconds 5
		$socket = [Net.WebSockets.ClientWebSocket]::new()
		$socket.ConnectAsync([Uri] $target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
		$request = [Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Runtime.evaluate","params":{"expression":"document.body.innerText","returnByValue":true}}')
		$socket.SendAsync([ArraySegment[byte]] $request, 'Text', $true, [Threading.CancellationToken]::None).Wait()
		$buffer = [byte[]]::new(1MB)
		$reply = [IO.MemoryStream]::new()
		do {
			$received = $socket.ReceiveAsync([ArraySegment[byte]] $buffer, [Threading.CancellationToken]::None).Result
			$reply.Write($buffer, 0, $received.Count)
		} until($received.EndOfMessage)
		$text = ([Text.Encoding]::UTF8.GetString($reply.ToArray()) | ConvertFrom-Json).result.result.value
		Set-Content -Path (Join-Path $Out ($label + '.version.txt')) -Value $text -Encoding utf8
		Write-Log ('saved chrome://version/?show-variations-cmd to ' + $label + '.version.txt')
	} catch {
		Write-Log ('chrome://version not saved - ' + $_)
	}
}
Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $browser.Id) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $browser.Id -Force -ErrorAction SilentlyContinue
Write-Log ('repro: ' + $(if($spinning) { 'spin' } else { 'quiet' }) + ' - ' + $spinning + ' renderers at 15%+ over the last third (' + ($averages -join '/') + '%, busiest first)')
