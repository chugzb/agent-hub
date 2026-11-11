param([ValidateRange(1,65535)][int]$Port=4646,[string]$HomeDir=$env:USERPROFILE,[switch]$SelfTest,[string]$TestStatePath='', [string]$SnapshotPath='', [int]$SmokeSeconds=0,[string]$SmokeResultPath='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Net.Http
if([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA'){throw 'Please launch with powershell.exe -STA'}
$mutex=$null
if(-not $SelfTest){
  $sha=[Security.Cryptography.SHA256]::Create()
  $key=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($HomeDir).ToLowerInvariant()+':'+$Port))).Replace('-','')
  $sha.Dispose();$created=$false
  $mutex=New-Object Threading.Mutex($true,('Local\AgentHubFloat-'+$key),[ref]$created)
  if(-not $created){$mutex.Dispose();exit 0}
}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="员工悬浮窗" Width="300" Height="200" MinWidth="300" MinHeight="58" MaxHeight="520" WindowStyle="None" AllowsTransparency="True"
 Background="Transparent" Topmost="True" ShowActivated="False" ResizeMode="CanResizeWithGrip" FontFamily="Microsoft YaHei UI,Segoe UI" FontSize="12">
 <Window.Resources>
  <SolidColorBrush x:Key="Ink" Color="#eef1f5"/><SolidColorBrush x:Key="Muted" Color="#a3abb6"/>
  <SolidColorBrush x:Key="Work" Color="#34d17a"/><SolidColorBrush x:Key="Attention" Color="#ff6b6b"/>
  <SolidColorBrush x:Key="Off" Color="#8b93a0"/><SolidColorBrush x:Key="Panel" Color="#202527"/>
  <Style TargetType="Button"><Setter Property="Background" Value="Transparent"/><Setter Property="Foreground" Value="{StaticResource Muted}"/>
   <Setter Property="BorderThickness" Value="0"/><Setter Property="FontSize" Value="14"/><Setter Property="Width" Value="26"/><Setter Property="Height" Value="18"/></Style>
 </Window.Resources>
 <Border Background="{StaticResource Panel}" BorderBrush="#596166" BorderThickness="1" CornerRadius="10" Padding="1">
  <Grid><Grid.RowDefinitions><RowDefinition Height="18"/><RowDefinition Height="28"/><RowDefinition Height="*"/></Grid.RowDefinitions>
   <DockPanel x:Name="Header" Grid.Row="0" Background="Transparent" LastChildFill="True">
    <StackPanel DockPanel.Dock="Right" Orientation="Horizontal"><Button x:Name="Toggle" Content="⋯" ToolTip="折叠或展开" AutomationProperties.Name="折叠或展开"/>
    <Button x:Name="Minimize" Content="−" ToolTip="最小化" AutomationProperties.Name="最小化"/></StackPanel><Border Background="Transparent"/>
   </DockPanel>
   <Border Grid.Row="1" BorderBrush="#394044" BorderThickness="0,0,0,1" Padding="4,0,2,0">
    <StackPanel Orientation="Horizontal" VerticalAlignment="Center" x:Name="Summary" TextBlock.Foreground="{StaticResource Ink}" TextBlock.FontWeight="SemiBold" TextBlock.FontSize="11.5">
     <TextBlock Text="在干活 "/><TextBlock x:Name="Working" Foreground="{StaticResource Work}"/><TextBlock Text=" · 要处理 "/><TextBlock x:Name="Attention" Foreground="{StaticResource Attention}"/>
     <TextBlock Text=" · 没额度 "/><TextBlock x:Name="Quota" Foreground="{StaticResource Off}"/><TextBlock Text=" · 歇着 "/><TextBlock x:Name="Idle"/>
    </StackPanel>
   </Border>
   <ScrollViewer x:Name="Body" Grid.Row="2" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Padding="4,4,4,7"><StackPanel x:Name="Rows"/></ScrollViewer>
  </Grid>
 </Border>
</Window>
'@
$reader=New-Object System.Xml.XmlNodeReader $xaml
$window=[Windows.Markup.XamlReader]::Load($reader)
$header=$window.FindName('Header');$toggle=$window.FindName('Toggle');$minimize=$window.FindName('Minimize');$body=$window.FindName('Body');$rows=$window.FindName('Rows')
$script:collapsed=$false;$script:expandedHeight=200
$toggle.Add_Click({
  if($script:collapsed){$body.Visibility='Visible';$window.Height=$script:expandedHeight;$script:collapsed=$false}
  else{$script:expandedHeight=$window.Height;$body.Visibility='Collapsed';$window.Height=58;$script:collapsed=$true}
})
$minimize.Add_Click({$window.WindowState='Minimized'})
$header.Add_MouseLeftButtonDown({if($_.OriginalSource -isnot [Windows.Controls.Button]){try{$window.DragMove()}catch{}}})
$menu=New-Object Windows.Controls.ContextMenu
foreach($title in @('折叠或展开','最小化','关闭')){
  $item=New-Object Windows.Controls.MenuItem;$item.Header=$title
  switch($title){
    '折叠或展开' {$item.Add_Click({$toggle.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))})}
    '最小化' {$item.Add_Click({$window.WindowState='Minimized'})}
    '关闭' {$item.Add_Click({$window.Close()})}
  }
  [void]$menu.Items.Add($item)
}
$header.ContextMenu=$menu
$window.Left=[Math]::Max(0,[Windows.SystemParameters]::WorkArea.Right-$window.Width-16);$window.Top=24
$script:avatarCache=@{}
$script:painted=0;$script:lastState=$null
function Paint-State($state){
  $script:painted++;$script:lastState=$state
  foreach($entry in @{Working='working';Attention='attention';Quota='quota';Idle='idle'}.GetEnumerator()){$window.FindName($entry.Key).Text=[string]$state.counts.($entry.Value)}
  $rows.Children.Clear()
  foreach($agent in $state.rows){
    $row=New-Object Windows.Controls.Grid;$row.Height=28;$row.Margin='2,0,2,0';$row.ToolTip=([string]$agent.name+' · '+[string]$agent.doing);$row.Focusable=$true
    [Windows.Automation.AutomationProperties]::SetName($row,$row.ToolTip)
    foreach($width in @('24','Auto','Auto','*','58')){$c=New-Object Windows.Controls.ColumnDefinition;$c.Width=[Windows.GridLengthConverter]::new().ConvertFromString($width);[void]$row.ColumnDefinitions.Add($c)}
    $avatar=[string]$agent.avatar
    if($avatar -notin @('codex','kiro','cursor','deepseek','claude')){$avatar='claude'}
    if(-not $script:avatarCache.ContainsKey($avatar)){
      $image=New-Object Windows.Media.Imaging.BitmapImage;$image.BeginInit();$image.UriSource=[Uri](Join-Path $PSScriptRoot ('float-assets\'+$avatar+'.png'));$image.CacheOption='OnLoad';$image.EndInit();$image.Freeze();$script:avatarCache[$avatar]=$image
    }
    $picture=New-Object Windows.Controls.Image;$picture.Source=$script:avatarCache[$avatar];$picture.Width=18;$picture.Height=18;[void]$row.Children.Add($picture)
    $name=New-Object Windows.Controls.TextBlock;$name.Text=[string]$agent.name;$name.FontWeight='SemiBold';$name.Foreground=$window.FindResource('Ink');$name.MaxWidth=74;$name.TextTrimming='CharacterEllipsis';$name.VerticalAlignment='Center';$name.Margin='2,0,5,0';[Windows.Controls.Grid]::SetColumn($name,1);[void]$row.Children.Add($name)
    $tag=New-Object Windows.Controls.Border;$tag.CornerRadius='7';$tag.Padding='4,0,4,0';$tag.Margin='0,5,5,5'
    $colors=@{Codex='#111827';Kiro='#13795b';Cursor='#3b6fd8';DS='#6b7280';Claude='#c96442'}
    $color=$colors[[string]$agent.tool];if(-not $color){$color=$colors.Claude};$tag.Background=[Windows.Media.BrushConverter]::new().ConvertFromString($color)
    $label=New-Object Windows.Controls.TextBlock;$label.Text=[string]$agent.tool;$label.FontSize=10;$label.Foreground=[Windows.Media.Brushes]::White;$label.FontWeight='SemiBold';$label.VerticalAlignment='Center';$tag.Child=$label;[Windows.Controls.Grid]::SetColumn($tag,2);[void]$row.Children.Add($tag)
    $doing=New-Object Windows.Controls.TextBlock;$doing.Text=[string]$agent.doing;$doing.TextTrimming='CharacterEllipsis';$doing.VerticalAlignment='Center';$doing.Foreground=$window.FindResource('Muted');[Windows.Controls.Grid]::SetColumn($doing,3);[void]$row.Children.Add($doing)
    if($agent.group -eq 'attention'){$doing.Foreground=$window.FindResource('Attention');$name.Foreground=$window.FindResource('Attention')}
    $elapsed=New-Object Windows.Controls.TextBlock;$elapsed.Text=[string]$agent.elapsed;$elapsed.FontSize=10.5;$elapsed.Foreground=$window.FindResource('Muted');$elapsed.VerticalAlignment='Center';$elapsed.HorizontalAlignment='Right';[Windows.Controls.Grid]::SetColumn($elapsed,4);[void]$row.Children.Add($elapsed)
    [void]$rows.Children.Add($row)
  }
  if(@($state.rows).Count -eq 0){$empty=New-Object Windows.Controls.TextBlock;$empty.Text='都歇着';$empty.Foreground=$window.FindResource('Muted');$empty.HorizontalAlignment='Center';$empty.Margin='0,15,0,15';[void]$rows.Children.Add($empty)}
  $script:expandedHeight=[Math]::Min(480,[Math]::Max(150,64+28*@($state.rows).Count))
  if(-not $script:collapsed){$window.Height=$script:expandedHeight}
  $window.Title='员工悬浮窗';$header.ToolTip='拖动移动 · 右键关闭';$window.Opacity=1
}
function Save-Snapshot {
  if(-not $SnapshotPath){return}
  $visual=$window.Content;$visual.Measure([Windows.Size]::new($window.Width,$window.Height));$visual.Arrange([Windows.Rect]::new(0,0,$window.Width,$window.Height));$visual.UpdateLayout()
  $bitmap=[Windows.Media.Imaging.RenderTargetBitmap]::new([int]($window.Width*2),[int]($window.Height*2),192,192,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($visual)
  $png=New-Object Windows.Media.Imaging.PngBitmapEncoder;$png.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap));$stream=[IO.File]::Create($SnapshotPath);try{$png.Save($stream)}finally{$stream.Dispose()}
}
try{
 if($SelfTest){
  $state=Get-Content -Raw -Encoding UTF8 -LiteralPath $TestStatePath | ConvertFrom-Json
  Paint-State $state
  $window.Measure([Windows.Size]::new($window.Width,$window.Height));$window.Arrange([Windows.Rect]::new(0,0,$window.Width,$window.Height));$window.UpdateLayout()
  if($SnapshotPath){
    $visual=$window.Content;$visual.Measure([Windows.Size]::new($window.Width,$window.Height));$visual.Arrange([Windows.Rect]::new(0,0,$window.Width,$window.Height));$visual.UpdateLayout()
    $bitmap=[Windows.Media.Imaging.RenderTargetBitmap]::new([int]($window.Width*2),[int]($window.Height*2),192,192,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($visual)
    $png=New-Object Windows.Media.Imaging.PngBitmapEncoder;$png.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap));$stream=[IO.File]::Create($SnapshotPath);try{$png.Save($stream)}finally{$stream.Dispose()}
  }
  $toggle.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
  if($body.Visibility -ne 'Collapsed' -or $window.Height -ne 58){throw 'collapse failed'}
  $toggle.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
  if($body.Visibility -ne 'Visible' -or -not $window.Topmost){throw 'expand/topmost failed'}
  $minimize.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
  if($window.WindowState -ne 'Minimized'){throw 'minimize handler failed'}
  $window.WindowState='Normal'
  if($window.FindName('Working').Text -ne [string]$state.counts.working){throw 'counts failed'}
  'WPF XAML/data/avatar/layout/topmost/collapse/expand self-test passed';exit 0
 }
 $handler=New-Object Net.Http.HttpClientHandler;$handler.UseProxy=$false;$handler.AllowAutoRedirect=$false
 $client=New-Object Net.Http.HttpClient($handler);$client.Timeout=[TimeSpan]::FromSeconds(2)
 $script:pending=$null;$script:nextAt=[DateTime]::MinValue
 $timer=New-Object Windows.Threading.DispatcherTimer;$timer.Interval=[TimeSpan]::FromMilliseconds(250)
 $timer.Add_Tick({
  if($script:pending){
    if(-not $script:pending.IsCompleted){return}
    try{Paint-State (($script:pending.GetAwaiter().GetResult()) | ConvertFrom-Json)}
    catch{$window.Title='员工悬浮窗 · 连接断开';$header.ToolTip='连接断开，显示上次结果；请先启动员工看板';$window.Opacity=0.65}
    $script:pending=$null;$script:nextAt=[DateTime]::Now.AddSeconds(3)
  }
  if([DateTime]::Now -ge $script:nextAt){$script:pending=$client.GetStringAsync(('http://127.0.0.1:'+ $Port +'/api/float'))}
 })
 if($SmokeSeconds -gt 0){
  $smoke=New-Object Windows.Threading.DispatcherTimer;$smoke.Interval=[TimeSpan]::FromSeconds($SmokeSeconds)
  $smoke.Add_Tick({
    $smoke.Stop();Save-Snapshot
    if($SmokeResultPath){@{painted=$script:painted;counts=$script:lastState.counts;topmost=$window.Topmost;rows=$rows.Children.Count} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $SmokeResultPath}
    $window.Close()
  });$smoke.Start()
 }
 $timer.Start();$window.Add_Closed({$timer.Stop();$client.Dispose()});[void]$window.ShowDialog()
 if($SmokeSeconds -gt 0 -and $script:painted -eq 0){throw 'Live API paint smoke test failed'}
}finally{if($mutex){$mutex.ReleaseMutex();$mutex.Dispose()}}
