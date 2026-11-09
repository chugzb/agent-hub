// 桌面悬浮窗：开机后一直浮在桌面上，展开是 300 宽的小卡片，收起是一颗 44 的小球。
// 内容来自本机看板的 /mini（board.mjs），只读、不联网。
// 编译：swiftc -O -o "~/Applications/Agent Hub.app/Contents/MacOS/AgentHub" float.swift
import AppKit
import WebKit

// 平时连本机看板的 4646；AGENT_HUB_BOARD 只在本地演练时用来换端口
private let BOARD_BASE = ProcessInfo.processInfo.environment["AGENT_HUB_BOARD"] ?? "http://127.0.0.1:4646"
private let BOARD_URL = URL(string: BOARD_BASE + "/mini")!
private let BOARD_HOME = URL(string: BOARD_BASE + "/")!
private let WIDTH: CGFloat = 300
private let STRIP_H: CGFloat = 24
private let MAX_H: CGFloat = 480
private let MIN_H: CGFloat = 150
private let BALL_SIDE: CGFloat = 44
private let FLOAT_LABEL = "dev.agent-hub.float"

private let defaults = UserDefaults.standard

final class FloatPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/* 顶部一条 24 高的拖动条：按住拖窗口，双击收起 / 展开，右边是收起按钮和菜单按钮 */
final class StripView: NSView {
  weak var controller: PanelController?
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { controller?.toggle(); return }
    window?.performDrag(with: event)
  }
  override func draw(_ dirtyRect: NSRect) {
    // 亮色下铺一层暖色，跟网页看板的地板一个调子（暗色留给毛玻璃）
    if effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua {
      NSColor(calibratedRed: 1, green: 0.965, blue: 0.91, alpha: 0.66).setFill()
      dirtyRect.fill()
    }
    // 左边六个小点，提示这里能拖
    NSColor.tertiaryLabelColor.setFill()
    for row in 0 ..< 2 {
      for col in 0 ..< 3 {
        let r = NSRect(x: 10 + CGFloat(col) * 4, y: 10 + CGFloat(row) * 4, width: 2, height: 2)
        NSBezierPath(ovalIn: r).fill()
      }
    }
  }
}

/* 收起后的小球：显示在干活人数；有人要处理时变红并呼吸 */
final class BallView: NSView {
  weak var controller: PanelController?
  var count: Int = 0 { didSet { needsDisplay = true } }
  var alert: Bool = false { didSet { needsDisplay = true; updatePulse() } }

  override func draw(_ dirtyRect: NSRect) {
    let side = min(bounds.width, bounds.height)
    let rect = NSRect(x: (bounds.width - side) / 2 + 1, y: (bounds.height - side) / 2 + 1, width: side - 2, height: side - 2)
    let path = NSBezierPath(ovalIn: rect)
    if alert { NSColor.systemRed.setFill() } else { NSColor(calibratedWhite: 0.16, alpha: 0.92).setFill() }
    path.fill()
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 16, weight: .semibold),
      .foregroundColor: NSColor.white,
    ]
    let text = NSAttributedString(string: "\(count)", attributes: attrs)
    let size = text.size()
    text.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
  }

  private func updatePulse() {
    wantsLayer = true
    layer?.removeAnimation(forKey: "breathe")
    guard alert else { layer?.opacity = 1; return }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 1.0
    a.toValue = 0.55
    a.duration = 1.1
    a.autoreverses = true
    a.repeatCount = .infinity
    a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    layer?.add(a, forKey: "breathe")
  }

  override func mouseDown(with event: NSEvent) {
    let from = NSEvent.mouseLocation
    window?.performDrag(with: event)   // 拖动由窗口接管；没动过就算一次点击
    let to = NSEvent.mouseLocation
    if hypot(to.x - from.x, to.y - from.y) < 3 { controller?.toggle() }
  }
}

final class PanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  let panel: FloatPanel
  private let effect = NSVisualEffectView()
  private let strip = StripView()
  private let web: WKWebView
  private let overlay = NSView()
  private let overlayLabel = NSTextField(labelWithString: "看板没在运行")
  private let ball = BallView()
  private var menuMonitor: Any?
  private var collapsed = false
  private var offline = false
  // 页面报高度之前先按最小高度开；看板没起来时那张「看板没在运行」的卡片就是小号的
  private var pageHeight: CGFloat = 150
  private var expandedTopLeft: NSPoint?
  private var ballTopLeft: NSPoint?
  // start() 摆好位置之前窗口会自己动（换 contentView、首次 setFrame），那会儿别把
  // 还没恢复的位置当成用户拖过的位置存下来，否则下次开就贴在屏幕左下角
  private var saveEnabled = false

  override init() {
    let cfg = WKWebViewConfiguration()
    web = WKWebView(frame: .zero, configuration: cfg)
    panel = FloatPanel(contentRect: NSRect(x: 0, y: 0, width: WIDTH, height: MIN_H),
                       styleMask: [.borderless, .nonactivatingPanel],
                       backing: .buffered, defer: false)
    super.init()
    buildPanel()
    buildExpanded()
    buildBall()
    cfg.userContentController.add(self, name: "height")
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")   // 透出底下的毛玻璃
    if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
    web.allowsMagnification = false
    strip.controller = self
    ball.controller = self
  }

  // MARK: - 组装

  private func buildPanel() {
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.worksWhenModal = true
    panel.isMovableByWindowBackground = true
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.delegate = self
  }

  private func buildExpanded() {
    effect.material = .popover
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.wantsLayer = true
    effect.layer?.cornerRadius = 12
    effect.layer?.masksToBounds = true
    effect.translatesAutoresizingMaskIntoConstraints = false

    strip.translatesAutoresizingMaskIntoConstraints = false
    web.translatesAutoresizingMaskIntoConstraints = false

    let minus = NSButton(title: "–", target: self, action: #selector(collapseTapped))
    minus.isBordered = false
    minus.font = .systemFont(ofSize: 14, weight: .medium)
    minus.translatesAutoresizingMaskIntoConstraints = false
    let more = NSButton(title: "⋯", target: self, action: #selector(menuTapped(_:)))
    more.isBordered = false
    more.font = .systemFont(ofSize: 13, weight: .medium)
    more.translatesAutoresizingMaskIntoConstraints = false

    effect.addSubview(strip)
    effect.addSubview(web)
    effect.addSubview(overlay)
    // 按钮得放进视图树，否则和 effect 没有共同父视图，加约束时直接抛异常（窗口就再也起不来）
    effect.addSubview(minus)
    effect.addSubview(more)

    overlay.translatesAutoresizingMaskIntoConstraints = false
    let retry = NSButton(title: "重试", target: self, action: #selector(retryTapped))
    retry.bezelStyle = .rounded
    retry.controlSize = .small
    retry.translatesAutoresizingMaskIntoConstraints = false
    overlayLabel.font = .systemFont(ofSize: 12.5)
    overlayLabel.textColor = .secondaryLabelColor
    overlayLabel.translatesAutoresizingMaskIntoConstraints = false
    overlay.addSubview(overlayLabel)
    overlay.addSubview(retry)
    overlay.isHidden = true

    NSLayoutConstraint.activate([
      strip.topAnchor.constraint(equalTo: effect.topAnchor),
      strip.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
      strip.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
      strip.heightAnchor.constraint(equalToConstant: STRIP_H),

      minus.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -10),
      minus.centerYAnchor.constraint(equalTo: strip.centerYAnchor),
      more.trailingAnchor.constraint(equalTo: minus.leadingAnchor, constant: -6),
      more.centerYAnchor.constraint(equalTo: strip.centerYAnchor),

      web.topAnchor.constraint(equalTo: strip.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
      web.bottomAnchor.constraint(equalTo: effect.bottomAnchor),

      overlay.centerXAnchor.constraint(equalTo: web.centerXAnchor),
      overlay.centerYAnchor.constraint(equalTo: web.centerYAnchor),
      overlayLabel.topAnchor.constraint(equalTo: overlay.topAnchor),
      overlayLabel.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
      retry.topAnchor.constraint(equalTo: overlayLabel.bottomAnchor, constant: 8),
      retry.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
      retry.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
    ])
  }

  private func buildBall() {
    ball.frame = NSRect(x: 0, y: 0, width: BALL_SIDE, height: BALL_SIDE)
    ball.toolTip = "Agent Hub"
  }

  // MARK: - 启动

  // 排查用：AGENT_HUB_DEBUG=1 时往 stderr 打（launchd 的 float.log 能收到）
  private func dbg(_ s: String) {
    guard ProcessInfo.processInfo.environment["AGENT_HUB_DEBUG"] != nil else { return }
    FileHandle.standardError.write(("[float] " + s + "\n").data(using: .utf8) ?? Data())
  }

  func start() {
    expandedTopLeft = Self.sanePoint(Self.loadPoint("expandedTopLeft"), width: WIDTH) ?? defaultTopLeft(width: WIDTH)
    ballTopLeft = Self.sanePoint(Self.loadPoint("ballTopLeft"), width: BALL_SIDE) ?? expandedTopLeft
    collapsed = defaults.bool(forKey: "collapsed")
    panel.alphaValue = alphaSetting()
    if collapsed { showBall(animated: false) } else { showExpanded(animated: false) }
    panel.orderFrontRegardless()
    saveEnabled = true
    dbg("start done frame=\(panel.frame) visible=\(String(describing: NSScreen.main?.visibleFrame))")
    installMenuMonitor()
    web.load(URLRequest(url: BOARD_URL))
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.retryIfOffline() }
  }

  private func defaultTopLeft(width: CGFloat) -> NSPoint {
    guard let vis = NSScreen.main?.visibleFrame else { return NSPoint(x: 100, y: 700) }
    return NSPoint(x: vis.maxX - width - 24, y: vis.maxY - 24)
  }

  private static func loadPoint(_ key: String) -> NSPoint? {
    guard let s = defaults.string(forKey: key) else { return nil }
    let p = NSPointFromString(s)
    return p == .zero ? nil : p
  }

  // 存下来的位置得在某一台屏幕的范围内（换过显示器、拔了外接屏时旧坐标会飘到屏幕外）
  private static func sanePoint(_ p: NSPoint?, width: CGFloat) -> NSPoint? {
    guard let p else { return nil }
    let probe = NSPoint(x: p.x + width / 2, y: p.y - 12)
    return NSScreen.screens.contains { $0.frame.insetBy(dx: -8, dy: -8).contains(probe) } ? p : nil
  }

  private func saveCurrentPoint() {
    guard saveEnabled else { return }
    let p = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
    if collapsed {
      ballTopLeft = p
      defaults.set(NSStringFromPoint(p), forKey: "ballTopLeft")
    } else {
      expandedTopLeft = p
      defaults.set(NSStringFromPoint(p), forKey: "expandedTopLeft")
    }
  }

  // MARK: - 展开 / 收起

  func toggle() {
    if collapsed { showExpanded(animated: true) } else { showBall(animated: true) }
  }

  @objc private func collapseTapped() { showBall(animated: true) }

  private func showBall(animated: Bool) {
    if !collapsed { saveCurrentPoint() }
    collapsed = true
    defaults.set(true, forKey: "collapsed")
    panel.contentView = ball
    let topLeft = ballTopLeft ?? expandedTopLeft ?? defaultTopLeft(width: BALL_SIDE)
    let origin = clampedOrigin(NSPoint(x: topLeft.x, y: topLeft.y - BALL_SIDE), size: NSSize(width: BALL_SIDE, height: BALL_SIDE))
    let rect = NSRect(origin: origin, size: NSSize(width: BALL_SIDE, height: BALL_SIDE))
    setFrame(rect, animated: animated)
    panel.invalidateShadow()
  }

  private func showExpanded(animated: Bool) {
    if collapsed { saveCurrentPoint() }
    collapsed = false
    defaults.set(false, forKey: "collapsed")
    panel.contentView = effect
    resizeExpanded(animated: animated)
    panel.invalidateShadow()
  }

  private func expandedHeight() -> CGFloat {
    min(max(pageHeight + STRIP_H, MIN_H), MAX_H)
  }

  private func resizeExpanded(animated: Bool) {
    let topLeft = expandedTopLeft ?? defaultTopLeft(width: WIDTH)
    let size = NSSize(width: WIDTH, height: expandedHeight())
    let origin = clampedOrigin(NSPoint(x: topLeft.x, y: topLeft.y - size.height), size: size)
    setFrame(NSRect(origin: origin, size: size), animated: animated)
  }

  private func setFrame(_ rect: NSRect, animated: Bool) {
    dbg("setFrame -> \(rect) animated=\(animated) before=\(panel.frame)")
    if animated {
      // 动画中间每一帧都会触发 windowDidMove；别把中间位置当成落点存进 UserDefaults
      saveEnabled = false
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.18
        panel.animator().setFrame(rect, display: true)
      }, completionHandler: { [weak self] in
        guard let self else { return }
        self.saveEnabled = true
        self.saveCurrentPoint()
      })
    } else {
      panel.setFrame(rect, display: true)
    }
  }

  private func clampedOrigin(_ origin: NSPoint, size: NSSize) -> NSPoint {
    let screen = NSScreen.screens.first { $0.frame.contains(NSPoint(x: origin.x + 1, y: origin.y + 1)) } ?? NSScreen.main
    guard let vis = screen?.visibleFrame else { return origin }
    return NSPoint(x: min(max(origin.x, vis.minX), vis.maxX - size.width),
                   y: min(max(origin.y, vis.minY), vis.maxY - size.height))
  }

  // MARK: - 数据

  private func poll() {
    web.evaluateJavaScript("JSON.stringify(window.__miniStats||{})") { [weak self] result, _ in
      guard let self,
            let s = result as? String,
            let data = s.data(using: .utf8),
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
      let work = (obj["work"] as? NSNumber)?.intValue ?? 0
      let att = (obj["att"] as? NSNumber)?.intValue ?? 0
      let pageOffline = (obj["offline"] as? Bool) ?? false
      self.ball.count = work
      self.ball.alert = att > 0
      if pageOffline && !self.offline { self.setOffline(true) }
    }
  }

  private func retryIfOffline() {
    if offline { web.load(URLRequest(url: BOARD_URL)) }
  }

  private func setOffline(_ value: Bool) {
    offline = value
    overlay.isHidden = !value
    web.isHidden = value   // 页面自己那行「连接断了」不要和被盖住的提示叠在一起
    if value { overlayLabel.stringValue = "看板没在运行" }
  }

  @objc private func retryTapped() {
    setOffline(false)
    web.load(URLRequest(url: BOARD_URL))
  }

  // MARK: - WKWebView

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "height", let n = message.body as? NSNumber else { return }
    pageHeight = CGFloat(truncating: n)
    if !collapsed { resizeExpanded(animated: true) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    setOffline(false)   // 高度由页面自己量好报上来（mini.html 的 reportHeight），这里不用再读一遍
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    setOffline(true)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    setOffline(true)
  }

  // 点人：target=_blank 的链接交给默认浏览器打开（带 /#who=<名字>）
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // MARK: - 右键菜单

  private func installMenuMonitor() {
    menuMonitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
      guard let self, event.window === self.panel else { return event }
      let point = self.panel.convertPoint(fromScreen: NSEvent.mouseLocation)
      self.makeMenu().popUp(positioning: nil, at: point, in: self.panel.contentView)
      return nil
    }
  }

  @objc private func menuTapped(_ sender: NSButton) {
    let point = NSPoint(x: sender.bounds.maxX, y: sender.bounds.minY - 2)
    makeMenu().popUp(positioning: nil, at: point, in: sender)
  }

  private func makeMenu() -> NSMenu {
    let menu = NSMenu()
    menu.addItem(item("打开完整看板", #selector(openBoard)))
    menu.addItem(.separator())
    menu.addItem(item(collapsed ? "展开" : "收起", #selector(menuToggle)))

    let alphaItem = NSMenuItem(title: "透明度", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    let current = alphaSetting()
    for (title, value) in [("100%", 1.0), ("85%", 0.85), ("70%", 0.7)] {
      let it = item(title, #selector(setAlpha(_:)))
      it.representedObject = value
      it.state = abs(current - value) < 0.01 ? .on : .off
      sub.addItem(it)
    }
    alphaItem.submenu = sub
    menu.addItem(alphaItem)

    let auto = item("开机自动启动", #selector(toggleAutoStart))
    auto.state = FileManager.default.fileExists(atPath: floatPlistURL.path) ? .on : .off
    menu.addItem(auto)
    menu.addItem(.separator())
    menu.addItem(item("退出", #selector(quit)))
    return menu
  }

  private func item(_ title: String, _ action: Selector) -> NSMenuItem {
    let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
    it.target = self
    return it
  }

  @objc private func openBoard() { NSWorkspace.shared.open(BOARD_HOME) }

  @objc private func menuToggle() { toggle() }

  @objc private func setAlpha(_ sender: NSMenuItem) {
    guard let value = sender.representedObject as? Double else { return }
    defaults.set(value, forKey: "alpha")
    panel.alphaValue = CGFloat(value)
  }

  private func alphaSetting() -> CGFloat {
    let v = defaults.object(forKey: "alpha") as? Double ?? 1.0
    return CGFloat(v)
  }

  // MARK: - 开机自动启动（launchd）

  private var floatPlistURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/\(FLOAT_LABEL).plist")
  }

  @objc private func toggleAutoStart() {
    if FileManager.default.fileExists(atPath: floatPlistURL.path) {
      bootout()
      try? FileManager.default.removeItem(at: floatPlistURL)
      return
    }
    let exe = Bundle.main.executablePath ?? ""
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let log = "\(home)/agy-logs/bridges/float.log"
    let dict: [String: Any] = [
      "Label": FLOAT_LABEL,
      "ProgramArguments": [exe],
      "RunAtLoad": true,
      "KeepAlive": false,
      "ProcessType": "Interactive",
      "StandardOutPath": log,
      "StandardErrorPath": log,
    ]
    try? FileManager.default.createDirectory(atPath: "\(home)/agy-logs/bridges", withIntermediateDirectories: true)
    do {
      let data = try PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
      try FileManager.default.createDirectory(at: floatPlistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: floatPlistURL)
    } catch {
      NSAlert(error: error).runModal()
      return
    }
    let r = runLaunchctl(["bootstrap", "gui/\(getuid())", floatPlistURL.path])
    if r != 0 { _ = runLaunchctl(["load", "-w", floatPlistURL.path]) }
  }

  private func bootout() {
    _ = runLaunchctl(["bootout", "gui/\(getuid())", floatPlistURL.path])
  }

  @discardableResult
  private func runLaunchctl(_ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
  }

  @objc private func quit() { NSApp.terminate(nil) }

  // MARK: - 窗口

  func windowDidMove(_ notification: Notification) { saveCurrentPoint() }
  func windowWillClose(_ notification: Notification) { saveCurrentPoint() }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var controller: PanelController?
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    controller = PanelController()
    controller?.start()
  }
}

@main
struct AgentHubFloat {
  static let held = AppDelegate()   // NSApplication.delegate 是弱引用，得自己拿住
  static func main() {
    let app = NSApplication.shared
    app.delegate = held
    app.run()
  }
}
