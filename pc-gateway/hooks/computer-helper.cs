// .NET Framework / WinForms, compiled once per worker by computer-helper.ps1. No third-party runtime or GPU model.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace HelixComputer {
  // Dedicated spectator encoder. Its kill-on-close job prevents orphan capture after a helper crash.
  internal sealed class ViewerCapture : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint limit; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED info,uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    Process process; IntPtr job; readonly int port; readonly bool jpeg;
    readonly object errorLock=new object(); string stderr="";
    internal Dictionary<string,object> Status() {
      var result=new Dictionary<string,object>{{"ok",true},{"running",Running}};
      if(process!=null&&process.HasExited)result["exitCode"]=process.ExitCode;
      lock(errorLock)result["stderr"]=stderr;
      return result;
    }
    internal Rectangle Region { get; private set; }
    internal ViewerCapture(Rectangle region,int destination,bool compatibility=false) { port=destination;jpeg=compatibility; Start(region); }
    internal bool Running { get { return process!=null&&!process.HasExited; } }
    void Start(Rectangle region) {
      Region=region;
      lock(errorLock)stderr="";
      string exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Microsoft","WinGet","Links","ffmpeg.exe");
      if(!File.Exists(exe))exe="ffmpeg.exe";
      string args="-hide_banner -loglevel error -nostdin -f gdigrab -framerate 30 -draw_mouse 1 -offset_x "+region.X+" -offset_y "+region.Y+" -video_size "+region.Width+"x"+region.Height+" -i desktop -an -vf \"scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2\" -filter_threads 1 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -level:v 3.1 -pix_fmt yuv420p -threads 2 -g 30 -keyint_min 30 -bf 0 -b:v 2000k -maxrate 2500k -bufsize 150k -x264-params repeat-headers=1:scenecut=0 -flush_packets 1 -f rtp -payload_type 96 rtp://127.0.0.1:"+port+"?pkt_size=1200";
      job=CreateJobObject(IntPtr.Zero,null);
      if(jpeg)args="-hide_banner -loglevel error -nostdin -f gdigrab -framerate 8 -draw_mouse 1 -offset_x "+region.X+" -offset_y "+region.Y+" -video_size "+region.Width+"x"+region.Height+" -i desktop -an -vf \"scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2\" -filter_threads 1 -c:v mjpeg -q:v 7 -threads 2 -f image2pipe tcp://127.0.0.1:"+port;
      var limits=new EXTENDED();limits.basic.flags=0x2000;
      if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED)))){Dispose();throw new InvalidOperationException("Cannot supervise viewer encoder.");}
      try {
        process=new Process {StartInfo=new ProcessStartInfo(exe,args){UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,RedirectStandardOutput=true}};
        process.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)lock(errorLock){stderr+=e.Data+"\n";if(stderr.Length>4096)stderr=stderr.Substring(stderr.Length-4096);}};
        process.OutputDataReceived+=(s,e)=>{};
        process.Start();
        if(!AssignProcessToJobObject(job,process.Handle))throw new InvalidOperationException("Cannot supervise viewer encoder process.");
        process.BeginErrorReadLine();process.BeginOutputReadLine();
      } catch {Dispose();throw;}
    }
    internal void Select(Rectangle region) { if(region==Region)return; Dispose();Start(region); }
    public void Dispose() {
      if(process!=null){try{if(!process.HasExited)process.Kill();}catch{}process.Dispose();process=null;}
      if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}
    }
  }

  internal static class Win {
    [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int x,y; public POINT(int a,int b){x=a;y=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct SIZE { public int cx,cy; public SIZE(int a,int b){cx=a;cy=b;} }
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] internal struct MONITORINFO { public int size; public RECT monitor,work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device; }
    [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct BLEND { public byte op,flags,alpha,format; }
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSE { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] internal struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { public uint type; public UNION u; }
    internal delegate bool MonitorProc(IntPtr h,IntPtr dc,ref RECT r,IntPtr data);
    internal delegate IntPtr HookProc(int code,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] internal static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorProc proc,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern bool GetMonitorInfo(IntPtr h,ref MONITORINFO info);
    [DllImport("shcore.dll")] internal static extern int GetDpiForMonitor(IntPtr h,int type,out uint x,out uint y);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr h,out RECT rect);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern int GetWindowText(IntPtr h,StringBuilder text,int max);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] internal static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder info,uint len,out uint needed);
    [DllImport("user32.dll",SetLastError=true)] internal static extern uint SendInput(uint count,INPUT[] input,int size);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
    [DllImport("user32.dll")] internal static extern bool SetWindowDisplayAffinity(IntPtr h,uint affinity);
    [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window,IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr window,IntPtr dc,ref POINT dst,ref SIZE size,IntPtr src,ref POINT zero,int key,ref BLEND blend,uint flags);
    [DllImport("user32.dll")] internal static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] internal static extern bool UnregisterHotKey(IntPtr h,int id);
    [DllImport("user32.dll")] internal static extern IntPtr SetWindowsHookEx(int id,HookProc proc,IntPtr module,uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr w,IntPtr l);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
    [DllImport("wtsapi32.dll")] internal static extern bool WTSQuerySessionInformation(IntPtr server,int session,int kind,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr buffer);
    internal static readonly UIntPtr Tag = new UIntPtr(0x48454c58);
    internal static void Mouse(uint flags,int x,int y,uint data) {
      Send(new INPUT {type=0,u=new UNION {mouse=new MOUSE {dx=x,dy=y,data=data,flags=flags,extra=Tag}}});
    }
    internal static void Key(ushort vk,ushort scan,uint flags) {
      Send(new INPUT {type=1,u=new UNION {key=new KEY {vk=vk,scan=scan,flags=flags,extra=Tag}}});
    }
    static void Send(INPUT input) {
      if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)
        throw new InvalidOperationException("Windows refused input (the target may be elevated or the desktop unavailable).");
    }
  }

  internal sealed class Monitor {
    internal string id; internal Rectangle rect; internal bool primary; internal uint dpi;
    internal Dictionary<string,object> Info(){return new Dictionary<string,object>{{"id",id},{"x",rect.X},{"y",rect.Y},{"width",rect.Width},{"height",rect.Height},{"primary",primary},{"dpi",dpi},{"scale",dpi/96.0}};}
  }

  // Per-pixel alpha; center pixels have alpha zero. The native transparent style also passes border clicks through.
  internal sealed class GoldOverlay : Form {
    readonly Monitor monitor; readonly bool label;
    internal GoldOverlay(Monitor m,bool showLabel) {
      monitor=m; label=showLabel; FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false;
      StartPosition=FormStartPosition.Manual; Bounds=m.rect; TopMost=true; AutoScaleMode=AutoScaleMode.None;
      Text="Helix desktop control indicator";
    }
    protected override bool ShowWithoutActivation { get {return true;} }
    internal string MonitorId { get { return monitor.id; } }
    protected override CreateParams CreateParams { get {var p=base.CreateParams; p.ExStyle|=0x80000|0x20|0x80|0x08000000; return p;} }
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x84){m.Result=new IntPtr(-1);return;} // HTTRANSPARENT
      if(m.Msg==0x21){m.Result=new IntPtr(3);return;} // MA_NOACTIVATE
      base.WndProc(ref m);
    }
    internal void PaintGold(bool bright) {
      using(var bitmap=RenderGold(monitor.rect.Width,monitor.rect.Height,monitor.dpi,label,bright)) {
        IntPtr dc=Win.GetDC(IntPtr.Zero), memory=Win.CreateCompatibleDC(dc), bits=bitmap.GetHbitmap(Color.FromArgb(0));
        IntPtr old=Win.SelectObject(memory,bits);
        try {
          var dst=new Win.POINT(monitor.rect.X,monitor.rect.Y); var zero=new Win.POINT(0,0); var size=new Win.SIZE(bitmap.Width,bitmap.Height);
          var blend=new Win.BLEND {op=0,alpha=255,format=1};
          if(!Win.UpdateLayeredWindow(Handle,dc,ref dst,ref size,memory,ref zero,0,ref blend,2)) throw new InvalidOperationException("Cannot draw the desktop control indicator.");
        } finally {Win.SelectObject(memory,old);Win.DeleteObject(bits);Win.DeleteDC(memory);Win.ReleaseDC(IntPtr.Zero,dc);}
      }
      if(!Win.SetWindowPos(Handle,new IntPtr(-1),monitor.rect.X,monitor.rect.Y,monitor.rect.Width,monitor.rect.Height,0x10|0x40))
        throw new InvalidOperationException("Cannot show the desktop control indicator.");
      // Optional: keep the indicator visible locally without adding gold edges to the model's screenshots.
      Win.SetWindowDisplayAffinity(Handle,0x11);
    }
    internal static Bitmap RenderGold(int width,int height,uint dpi,bool label,bool bright) {
      double scale=dpi/96.0;
      var bitmap=new Bitmap(width,height,PixelFormat.Format32bppPArgb);
      try {
        // Precompute the falloff once per distance. Only perimeter pixels are written; the center stays alpha zero.
        // Two perpendicular edges combine at corners, making them richer without drawing a box-shaped corner stroke.
        int shortest=Math.Min(width,height);
        int fade=Math.Min((shortest-1)/2,Math.Max((int)Math.Round(72*scale),Math.Min((int)Math.Round(120*scale),(int)Math.Round(shortest*0.11))));
        fade=Math.Max(1,fade);
        double halo=Math.Max(24*scale,Math.Min(48*scale,fade*0.42));
        var alpha=new double[fade+1];var lineStrength=new double[fade+1];
        for(int d=0;d<fade;d++) {
          double remaining=1.0-d/(double)fade;
          lineStrength[d]=Math.Exp(-0.5*Math.Pow((d-1.6*scale)/(1.15*scale),2));
          double ambient=0.30*Math.Pow(remaining,1.7);
          double wide=0.16*Math.Exp(-Math.Pow((d-halo*0.35)/(halo*0.70),2))*Math.Pow(remaining,1.2);
          alpha[d]=Math.Min(0.95,(ambient+wide+0.62*lineStrength[d])*(bright?1.16:1.0));
        }
        var data=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.WriteOnly,PixelFormat.Format32bppPArgb);
        try {
          int stride=Math.Abs(data.Stride);var pixels=new byte[stride*height];
          for(int y=0;y<height;y++) {
            int dy=Math.Min(y,height-1-y),row=(data.Stride>=0?y:height-1-y)*stride;
            for(int x=0;x<width;x++) {
              int dx=Math.Min(x,width-1-x);
              if(dx>=fade&&dy>=fade)continue;
              double ax=dx<fade?alpha[dx]:0,ay=dy<fade?alpha[dy]:0;
              double a=1-(1-ax)*(1-ay);
              int opacity=(int)Math.Round(255*Math.Min(0.98,a));
              double sharp=Math.Min(1,(dx<fade?lineStrength[dx]:0)+(dy<fade?lineStrength[dy]:0));
              int green=(int)Math.Round(185+40*sharp),blue=(int)Math.Round(75+61*sharp);
              int p=row+x*4;
              pixels[p]=(byte)((blue*opacity+127)/255);
              pixels[p+1]=(byte)((green*opacity+127)/255);
              pixels[p+2]=(byte)((249*opacity+127)/255);
              pixels[p+3]=(byte)opacity;
            }
          }
          Marshal.Copy(pixels,0,data.Scan0,pixels.Length);
        } finally {bitmap.UnlockBits(data);}
        if(label)using(var g=Graphics.FromImage(bitmap)) {
          g.SmoothingMode=SmoothingMode.AntiAlias;
          using(var font=new Font("Segoe UI",(float)(10*scale),FontStyle.Regular,GraphicsUnit.Pixel))
          using(var brush=new SolidBrush(Color.FromArgb(190,249,225,136)))
            g.DrawString("HELIX ACTIVE",font,brush,new PointF((float)(18*scale),(float)(10*scale)));
        }
        return bitmap;
      } catch { bitmap.Dispose();throw; }
    }
  }

  public sealed class Worker : Form {
    readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=24*1024*1024};
    readonly List<GoldOverlay> overlays=new List<GoldOverlay>();
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer {Interval=100};
    NamedPipeServerStream pipe; bool authenticated,active,pulse,showLabel;
    string secret,layout="",stopReason="not started"; DateTime heartbeat=DateTime.UtcNow,lease=DateTime.MinValue,brightUntil=DateTime.MinValue;
    IntPtr mouseHook,keyHook; Win.HookProc mouseProc,keyProc; DateTime hooksArmed;
    readonly List<ushort> held=new List<ushort>(); bool leftHeld;
    ViewerCapture viewer; Rectangle viewerRegion; Action<string> notify; string viewerFailure="";

    public static void Run(string pipeName,string token) {
      if(!System.Text.RegularExpressions.Regex.IsMatch(pipeName,"^helix-computer-[0-9a-f-]{36}$")) throw new ArgumentException("invalid pipe");
      if(Win.SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new InvalidOperationException("Per-monitor DPI awareness is unavailable.");
      Application.EnableVisualStyles();
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
      using(var w=new Worker()) {
        w.secret=token; w.CreateHandle();
        var security=new PipeSecurity(); security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        w.pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);
        w.timer.Tick+=(s,e)=>w.Tick(); w.timer.Start();
        var thread=new Thread(w.Serve); thread.IsBackground=true; thread.Start();
        try { Application.Run(); }
        finally { w.Stop("helper closed"); w.pipe.Dispose(); w.timer.Dispose(); }
      }
    }
    protected override void SetVisibleCore(bool value){base.SetVisibleCore(false);}
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x312){Stop("local stop shortcut");return;}
      if(m.Msg==0x7E && active) Stop("monitor layout changed; take a new screenshot and start again");
      base.WndProc(ref m);
    }
    void Serve() {
      try {
        pipe.WaitForConnection();
        using(var reader=new StreamReader(pipe,new UTF8Encoding(false),false,65536,true))
        using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),65536,true){AutoFlush=true}) {
          var writeLock=new object();
          notify=line=>{lock(writeLock)writer.WriteLine(line);};
          while(true) {
            // Bounded line reader: same-user access still must not allocate an unbounded request.
            var b=new StringBuilder(); int c;
            while((c=reader.Read())!=-1 && c!=10){if(b.Length>65536)throw new IOException("request too large");b.Append((char)c);}
            if(c==-1)break;
            var request=json.Deserialize<Dictionary<string,object>>(b.ToString()); Dictionary<string,object> result=null;
            Invoke(new Action(()=>{try{result=Dispatch(request);}catch(Exception ex){result=new Dictionary<string,object>{{"ok",false},{"error",ex.Message}};}}));
            result["id"]=request.ContainsKey("id")?request["id"]:"";
            lock(writeLock)writer.WriteLine(json.Serialize(result));
          }
        }
      } catch { /* watchdog shuts down the UI; no command or screenshot logging */ }
      finally {try{BeginInvoke(new Action(()=>{Stop("connection closed");Application.ExitThread();}));}catch{}}
    }
    static string Str(Dictionary<string,object> d,string k,string fallback=""){return d.ContainsKey(k)?Convert.ToString(d[k]):fallback;}
    static int Num(Dictionary<string,object> d,string k,int fallback=0){return d.ContainsKey(k)?Convert.ToInt32(d[k]):fallback;}
    static bool Flag(Dictionary<string,object> d,string k){return d.ContainsKey(k)&&Convert.ToBoolean(d[k]);}
    static Dictionary<string,object> Ok(){return new Dictionary<string,object>{{"ok",true}};}
    static List<Monitor> Monitors() {
      var result=new List<Monitor>();
      Win.MonitorProc cb=delegate(IntPtr h,IntPtr dc,ref Win.RECT r,IntPtr data){
        var info=new Win.MONITORINFO {size=Marshal.SizeOf(typeof(Win.MONITORINFO))};
        if(!Win.GetMonitorInfo(h,ref info))throw new InvalidOperationException("Cannot inspect monitor.");
        uint x,y; if(Win.GetDpiForMonitor(h,0,out x,out y)!=0)x=96;
        result.Add(new Monitor{id=info.device,rect=Rectangle.FromLTRB(info.monitor.left,info.monitor.top,info.monitor.right,info.monitor.bottom),primary=(info.flags&1)!=0,dpi=x});return true;
      };
      if(!Win.EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,cb,IntPtr.Zero)||result.Count==0)throw new InvalidOperationException("No interactive monitors.");
      result.Sort((a,b)=>String.CompareOrdinal(a.id,b.id));return result;
    }
    static new string Layout(List<Monitor> monitors){var b=new StringBuilder();foreach(var m in monitors)b.Append(m.id+":"+m.rect+":"+m.dpi+";");return b.ToString();}
    static new Rectangle Bounds(List<Monitor> monitors){var r=monitors[0].rect;foreach(var m in monitors)r=Rectangle.Union(r,m.rect);return r;}
    static Monitor MonitorAt(List<Monitor> monitors,int x,int y){return monitors.Find(m=>m.rect.Contains(x,y));}
    static Monitor CurrentMonitor(List<Monitor> monitors) {
      Win.RECT window;var h=Win.GetForegroundWindow();
      if(h!=IntPtr.Zero&&Win.GetWindowRect(h,out window)) {
        var center=MonitorAt(monitors,window.left+(window.right-window.left)/2,window.top+(window.bottom-window.top)/2);
        if(center!=null)return center;
      }
      Win.POINT cursor;if(Win.GetCursorPos(out cursor)){var pointed=MonitorAt(monitors,cursor.x,cursor.y);if(pointed!=null)return pointed;}
      return monitors.Find(m=>m.primary)??monitors[0];
    }
    void SetIndicators(List<Monitor> monitors,List<Monitor> selected) {
      if(selected.Count==0)throw new InvalidOperationException("No active monitor for the desktop indicator.");
      viewerRegion=Bounds(selected);
      if(viewer!=null)try{viewer.Select(viewerRegion);}catch(Exception e){viewerFailure="Monitor switch failed: "+e.Message;viewer.Dispose();viewer=null;}
      var desired=new HashSet<string>();foreach(var m in selected)desired.Add(m.id);
      if(overlays.Count==desired.Count&&overlays.TrueForAll(o=>desired.Contains(o.MonitorId)))return;
      try {
        foreach(var m in monitors)if(desired.Contains(m.id)&&!overlays.Exists(o=>o.MonitorId==m.id)) {
          var overlay=new GoldOverlay(m,showLabel);overlays.Add(overlay);overlay.Show();overlay.PaintGold(false);
        }
        for(int i=overlays.Count-1;i>=0;i--)if(!desired.Contains(overlays[i].MonitorId)) {
          overlays[i].Hide();overlays[i].Dispose();overlays.RemoveAt(i);
        }
      } catch {Stop("desktop indicator failed while changing monitors");throw;}
    }
    static bool DesktopAvailable() {
      IntPtr state;int bytes;
      if(!Win.WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,8,out state,out bytes))return false;
      try {if(bytes<4||Marshal.ReadInt32(state)!=0)return false;}finally{Win.WTSFreeMemory(state);}
      var h=Win.OpenInputDesktop(0,false,1); if(h==IntPtr.Zero)return false;
      try {var name=new StringBuilder(256);uint n;return Win.GetUserObjectInformation(h,2,name,512,out n)&&name.ToString()=="Default";}
      finally {Win.CloseDesktop(h);}
    }
    static Dictionary<string,object> ActiveWindow() {
      var h=Win.GetForegroundWindow();var title=new StringBuilder(512);Win.GetWindowText(h,title,title.Capacity);
      Win.RECT r;Win.GetWindowRect(h,out r);uint pid;Win.GetWindowThreadProcessId(h,out pid);
      return new Dictionary<string,object>{{"handle",h.ToInt64().ToString()},{"title",title.ToString()},{"pid",pid},{"x",r.left},{"y",r.top},{"width",r.right-r.left},{"height",r.bottom-r.top}};
    }
    void Tick() {
      if((DateTime.UtcNow-heartbeat).TotalSeconds>(authenticated?10:25)){Stop("gateway heartbeat lost");pipe.Dispose();Application.ExitThread();return;}
      if(!active)return;
      if(DateTime.UtcNow>lease){Stop("control session expired");return;}
      if(!DesktopAvailable()){Stop("desktop locked or secure desktop active");return;}
      if(Layout(Monitors())!=layout){Stop("monitor layout changed");return;}
      if(overlays.Count==0){Stop("desktop indicator unavailable");return;}
      foreach(var o in overlays)if(o.IsDisposed||!o.Visible){Stop("desktop indicator unavailable");return;}
      if((DateTime.UtcNow-hooksArmed).TotalSeconds>=1){try{ArmTakeover();}catch{Stop("takeover detection failed");return;}}
      if(brightUntil!=DateTime.MinValue&&DateTime.UtcNow>brightUntil){brightUntil=DateTime.MinValue;foreach(var o in overlays)o.PaintGold(false);}
    }
    string Start(bool label,bool animate) {
      if(!DesktopAvailable())throw new InvalidOperationException("Unlock your Windows desktop before starting control.");
      Stop("restarting"); pulse=animate;showLabel=label;
      try {
        var monitors=Monitors();layout=Layout(monitors);
        var current=CurrentMonitor(monitors);
        SetIndicators(monitors,new List<Monitor>{current});
        if(!Win.RegisterHotKey(Handle,1,0x4000|1|2|4,0x7B))throw new InvalidOperationException("Cannot register Ctrl+Alt+Shift+F12 stop shortcut.");
        mouseProc=(code,w,l)=>{
          if(code>=0&&(Marshal.ReadInt32(l,12)&1)==0&&active)Stop("physical mouse input; user took over");
          return Win.CallNextHookEx(IntPtr.Zero,code,w,l);
        };
        keyProc=(code,w,l)=>{
          if(code>=0&&(Marshal.ReadInt32(l,8)&0x10)==0&&active)Stop("physical keyboard input; user took over");
          return Win.CallNextHookEx(IntPtr.Zero,code,w,l);
        };
        ArmTakeover();
        active=true;lease=DateTime.UtcNow.AddSeconds(120);stopReason="";
        return current.id;
      } catch {Stop("indicator or takeover detection failed");throw;}
    }
    // Windows silently removes a low-level hook that once answers too slowly (this thread busy with a large capture),
    // and physical input would then no longer stop control. Tick re-arms them every second, new ones before old ones go.
    void ArmTakeover() {
      var module=Win.GetModuleHandle(null);
      var m=Win.SetWindowsHookEx(14,mouseProc,module,0);var k=Win.SetWindowsHookEx(13,keyProc,module,0);
      if(m==IntPtr.Zero||k==IntPtr.Zero){
        if(m!=IntPtr.Zero)Win.UnhookWindowsHookEx(m);
        if(k!=IntPtr.Zero)Win.UnhookWindowsHookEx(k);
        throw new InvalidOperationException("Cannot install local takeover detection.");
      }
      if(mouseHook!=IntPtr.Zero)Win.UnhookWindowsHookEx(mouseHook);
      if(keyHook!=IntPtr.Zero)Win.UnhookWindowsHookEx(keyHook);
      mouseHook=m;keyHook=k;hooksArmed=DateTime.UtcNow;
    }
    void Stop(string reason) {
      bool wasActive=active;
      active=false;stopReason=reason;brightUntil=DateTime.MinValue;
      if(viewer!=null){viewer.Dispose();viewer=null;}
      if(wasActive&&notify!=null)try{notify("{\"event\":\"control_stopped\"}");}catch{}
      if(mouseHook!=IntPtr.Zero)Win.UnhookWindowsHookEx(mouseHook);mouseHook=IntPtr.Zero;
      if(keyHook!=IntPtr.Zero)Win.UnhookWindowsHookEx(keyHook);keyHook=IntPtr.Zero;
      Win.UnregisterHotKey(Handle,1);Release();
      foreach(var o in overlays){o.Hide();o.Dispose();}overlays.Clear();
    }
    void Release() {
      foreach(var k in held)try{Win.Key(k,0,KeyFlags(k)|2);}catch{}held.Clear();
      if(leftHeld)try{Win.Mouse(4,0,0,0);}catch{}leftHeld=false;
    }
    void Check() {
      if(!active)throw new InvalidOperationException("Desktop control stopped: "+stopReason+". Start a new control session.");
      if(!DesktopAvailable()){Stop("desktop unavailable");throw new InvalidOperationException("Desktop locked or secure desktop active.");}
      if(overlays.Count==0) {Stop("indicator unavailable");throw new InvalidOperationException("Desktop indicator unavailable.");}
      if(DateTime.UtcNow>lease){Stop("control session expired");throw new InvalidOperationException("Control session expired.");}
    }
    void Wait(int ms) {var until=DateTime.UtcNow.AddMilliseconds(ms);while(DateTime.UtcNow<until){Application.DoEvents();Check();Thread.Sleep(5);}}
    new void Move(int x,int y,List<Monitor> monitors) {
      Check(); if(!monitors.Exists(m=>m.rect.Contains(x,y)))throw new ArgumentException("Point is outside all monitors.");
      var r=Bounds(monitors);
      int nx=(int)Math.Round((x-r.X)*65535.0/Math.Max(1,r.Width-1)),ny=(int)Math.Round((y-r.Y)*65535.0/Math.Max(1,r.Height-1));
      Win.Mouse(0x8000|0x4000|1,nx,ny,0);
    }
    static ushort KeyCode(string name) {
      name=name.ToLowerInvariant();
      switch(name){case "ctrl":case "control":return 0x11;case "alt":return 0x12;case "shift":return 0x10;case "win":case "meta":return 0x5B;
        case "enter":case "return":return 0x0D;case "tab":return 9;case "escape":case "esc":return 0x1B;case "space":return 0x20;
        case "backspace":return 8;case "delete":case "del":return 0x2E;case "insert":return 0x2D;
        case "left":return 0x25;case "up":return 0x26;case "right":return 0x27;case "down":return 0x28;
        case "home":return 0x24;case "end":return 0x23;case "pageup":return 0x21;case "pagedown":return 0x22;}
      int f;if(name.StartsWith("f")&&int.TryParse(name.Substring(1),out f)&&f>=1&&f<=24)return (ushort)(0x70+f-1);
      if(name.Length==1&&((name[0]>='a'&&name[0]<='z')||(name[0]>='0'&&name[0]<='9')))return (ushort)Char.ToUpperInvariant(name[0]);
      throw new ArgumentException("Unknown key name. Use type_text for punctuation and Unicode.");
    }
    static uint KeyFlags(ushort key){return (key>=0x21&&key<=0x2E)||key==0x5B?1u:0u;}
    new Dictionary<string,object> Capture(Dictionary<string,object> d) {
      Check();var monitors=Monitors();var key=Layout(monitors);
      var capturedWindow=ActiveWindow();
      if(key!=layout){Stop("monitor layout changed");throw new InvalidOperationException("Monitor layout changed. Start again.");}
      string which=Str(d,"monitorId");Rectangle region;
      if(which=="all")region=Bounds(monitors);
      else {var monitor=which==""?CurrentMonitor(monitors):monitors.Find(m=>m.id==which);if(monitor==null)throw new ArgumentException("Unknown monitor id.");region=monitor.rect;which=monitor.id;}
      if(d.ContainsKey("crop")) {
        var crop=(Dictionary<string,object>)d["crop"];var r=new Rectangle(region.X+Num(crop,"x"),region.Y+Num(crop,"y"),Num(crop,"width"),Num(crop,"height"));
        if(r.Width<1||r.Height<1||!region.Contains(r))throw new ArgumentException("Crop is outside capture bounds.");region=r;
      }
      if((long)region.Width*region.Height>80000000)throw new ArgumentException("Desktop too large. Capture an individual monitor or crop.");
      int max=Num(d,"maxEdge",1600);if(max<320||max>2560)throw new ArgumentException("maxEdge must be 320..2560.");
      SetIndicators(monitors,which=="all"?monitors:new List<Monitor>{monitors.Find(m=>m.id==which)});
      double ratio=Math.Min(1,Math.Min(max/(double)region.Width,max/(double)region.Height));
      int width=Math.Max(1,(int)Math.Round(region.Width*ratio)),height=Math.Max(1,(int)Math.Round(region.Height*ratio));
      using(var full=new Bitmap(region.Width,region.Height,PixelFormat.Format32bppArgb)) {
        using(var g=Graphics.FromImage(full))g.CopyFromScreen(region.Location,Point.Empty,region.Size,CopyPixelOperation.SourceCopy);
        using(var scaled=new Bitmap(width,height,PixelFormat.Format24bppRgb)) {
          using(var g=Graphics.FromImage(scaled)){g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(full,new Rectangle(0,0,width,height));}
          using(var bytes=new MemoryStream()) {
            bool jpeg=Str(d,"format","png")=="jpeg";scaled.Save(bytes,jpeg?ImageFormat.Jpeg:ImageFormat.Png);
            if(bytes.Length>12*1024*1024)throw new InvalidOperationException("Screenshot too large; use JPEG or a smaller capture.");
            if(Convert.ToString(capturedWindow["handle"])!=Convert.ToString(ActiveWindow()["handle"]))throw new InvalidOperationException("Active window changed during capture. Take another screenshot.");
            return new Dictionary<string,object>{{"ok",true},{"image",Convert.ToBase64String(bytes.ToArray())},{"mimeType",jpeg?"image/jpeg":"image/png"},{"width",width},{"height",height},{"monitorId",which},{"bounds",new Dictionary<string,object>{{"x",region.X},{"y",region.Y},{"width",region.Width},{"height",region.Height}}},{"layout",key},{"capturedAt",DateTime.UtcNow.ToString("o")},{"activeWindow",capturedWindow}};
          }
        }
      }
    }
    Dictionary<string,object> Dispatch(Dictionary<string,object> d) {
      string op=Str(d,"op");
      if(!authenticated) {
        if(op!="hello"||Str(d,"secret")!=secret)throw new UnauthorizedAccessException("Authentication failed.");
        authenticated=true;secret="";heartbeat=DateTime.UtcNow;return Ok();
      }
      if(op=="heartbeat"){heartbeat=DateTime.UtcNow;var h=Ok();h["active"]=active;h["reason"]=stopReason;return h;}
      if(op=="stop"){Stop("control ended");return Ok();}
      if(op=="start"){string selected=Start(Flag(d,"label"),Flag(d,"pulse"));var r=Ok();r["monitorId"]=selected;return r;}
      if(op=="info") {
        var monitors=Monitors();var r=Ok();var list=new List<object>();foreach(var m in monitors)list.Add(m.Info());
        r["monitors"]=list;r["layout"]=Layout(monitors);r["activeWindow"]=ActiveWindow();r["available"]=DesktopAvailable();r["active"]=active;r["stopReason"]=stopReason;return r;
      }
      if(op=="viewer_status") {Check();return viewer!=null?viewer.Status():new Dictionary<string,object>{{"ok",true},{"running",false},{"stderr",viewerFailure}};}
      if(op=="viewer_stop"){if(viewer!=null){viewer.Dispose();viewer=null;}return Ok();}
      if(op=="viewer_start") {
        Check();int port=Num(d,"port");if(port<1024||port>65535)throw new ArgumentException("Invalid viewer port.");
        if(viewer!=null){viewer.Dispose();viewer=null;}
        string format=Str(d,"format","rtp");if(format!="rtp"&&format!="jpeg")throw new ArgumentException("Invalid viewer format.");
        viewerFailure="";viewer=new ViewerCapture(viewerRegion,port,format=="jpeg");return Ok();
      }
      Check();lease=DateTime.UtcNow.AddSeconds(120);
      if(op=="capture")return Capture(d);
      if(op!="action")throw new ArgumentException("Unknown desktop operation.");
      var screens=Monitors();if(Str(d,"layout")!=Layout(screens)){Stop("monitor layout changed");throw new InvalidOperationException("Stale monitor layout; input refused.");}
      string expected=Str(d,"expectedWindow");
      if(expected!=""&&expected!=Convert.ToString(ActiveWindow()["handle"]))throw new InvalidOperationException("Active window changed; take a fresh screenshot before typing.");
      string kind=Str(d,"kind");var result=Ok();result["executed"]=false;
      try {
        var selected=new List<Monitor>();
        if(kind=="click"||kind=="double_click"||kind=="right_click"||kind=="move_mouse"||kind=="drag"||kind=="scroll") {
          var source=MonitorAt(screens,Num(d,"x"),Num(d,"y"));
          if(source==null)throw new ArgumentException("Input point is outside all monitors.");
          selected.Add(source);
          if(kind=="drag") {
            var target=MonitorAt(screens,Num(d,"x2"),Num(d,"y2"));
            if(target==null)throw new ArgumentException("Drag endpoint is outside all monitors.");
            if(target.id!=source.id)selected.Add(target);
          }
        } else selected.Add(CurrentMonitor(screens));
        SetIndicators(screens,selected);
        result["monitorId"]=selected.Count==1?selected[0].id:"all";
        if(pulse){foreach(var o in overlays)o.PaintGold(true);brightUntil=DateTime.UtcNow.AddMilliseconds(160);}
        foreach(int modifier in new int[]{0x10,0x11,0x12,0x5B,0x5C})if(Win.GetAsyncKeyState(modifier)<0)throw new InvalidOperationException("A modifier is already held. Release it before control.");
        result["executed"]=true; // from this point input may have partially executed; never blindly retry
        if(kind=="click"||kind=="double_click"||kind=="right_click"||kind=="move_mouse"||kind=="drag"||kind=="scroll")Move(Num(d,"x"),Num(d,"y"),screens);
        if(kind=="click"||kind=="right_click"||kind=="double_click") {
          bool right=kind=="right_click";int count=kind=="double_click"?2:1;
          for(int i=0;i<count;i++){Check();try{Win.Mouse(right?8u:2u,0,0,0);}finally{Win.Mouse(right?16u:4u,0,0,0);}if(i+1<count)Wait(65);}
        } else if(kind=="drag") {
          int x=Num(d,"x"),y=Num(d,"y"),endX=Num(d,"x2"),endY=Num(d,"y2");
          if(!screens.Exists(m=>m.rect.Contains(endX,endY)))throw new ArgumentException("Drag endpoint outside monitors.");
          leftHeld=true;Win.Mouse(2,0,0,0);
          for(int i=1;i<=20;i++){Wait(20);int mx=x+(endX-x)*i/20,my=y+(endY-y)*i/20;if(screens.Exists(m=>m.rect.Contains(mx,my)))Move(mx,my,screens);}
          Move(endX,endY,screens);Release();
        } else if(kind=="scroll") {
          int delta=Num(d,"delta");if(Math.Abs((long)delta)>20)throw new ArgumentException("Scroll is limited to 20 notches.");
          Win.Mouse(Flag(d,"horizontal")?0x1000u:0x800u,0,0,unchecked((uint)(delta*120)));
        } else if(kind=="press_key") {
          string[] names=Str(d,"key").Split('+');if(names.Length>5)throw new ArgumentException("Too many keys.");
          var codes=new List<ushort>();foreach(var name in names)codes.Add(KeyCode(name.Trim()));
          foreach(var code in codes){held.Insert(0,code);Win.Key(code,0,KeyFlags(code));}Release();
        } else if(kind=="type_text") {
          string text=Str(d,"text");if(text.Length>4000)throw new ArgumentException("Text limited to 4000 characters per call.");
          int i=0;foreach(char ch in text){if(i++%32==0){Application.DoEvents();Check();}if(ch=='\r')continue;
            if(expected!=""&&expected!=Win.GetForegroundWindow().ToInt64().ToString())throw new InvalidOperationException("Focus changed while typing; remaining text was not sent.");
            if(ch=='\n'||ch=='\t'){ushort vk=(ushort)(ch=='\n'?13:9);try{Win.Key(vk,0,0);}finally{Win.Key(vk,0,2);}}
            else {try{Win.Key(0,ch,4);}finally{Win.Key(0,ch,4|2);}}
          }
        } else if(kind!="move_mouse")throw new ArgumentException("Unknown input action.");
        Wait(Math.Max(0,Math.Min(1500,Num(d,"settleMs",180))));
        if(kind=="press_key") {
          var focused=CurrentMonitor(screens);
          SetIndicators(screens,new List<Monitor>{focused});
          result["monitorId"]=focused.id;
        }
      } catch(Exception ex){result["ok"]=false;result["error"]=ex.Message;}
      finally {Release();}
      return result;
    }
  }
}
