using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace HelixComputer {
  // Explicit, opt-in native integration check. All input is directed into this disposable scratch form.
  public static class NativeCheck {
    public static string Preview(string output) {
      using(var gold=GoldOverlay.RenderGold(960,540,96,true,false)) {
        Require(gold.GetPixel(480,270).A==0,"Overlay center must be fully transparent.");
        Require(gold.GetPixel(1,270).A>200,"Gold edge must be visible.");
        Require(gold.GetPixel(36,270).A>15,"The soft halo must extend inward.");
        Require(gold.GetPixel(36,36).A>gold.GetPixel(36,270).A,"Corners should carry a richer glow.");
        Require(gold.GetPixel(80,270).A==0,"The centerward fade must end in full transparency.");
        using(var pulse=GoldOverlay.RenderGold(960,540,96,false,true))
          Require(pulse.GetPixel(36,270).A>gold.GetPixel(36,270).A,"Action pulse should brighten the halo.");
        using(var large=GoldOverlay.RenderGold(2560,1440,144,false,false)) {
          Require(large.GetPixel(1280,720).A==0,"Large-monitor center must be fully transparent.");
          Require(large.GetPixel(80,720).A>0,"High-DPI halo must remain visible well inside the edge.");
        }
        using(var backdrop=new Bitmap(960,540)) {
          using(var g=Graphics.FromImage(backdrop)) {
            g.Clear(Color.FromArgb(13,14,15));
            using(var font=new Font("Segoe UI",22))using(var brush=new SolidBrush(Color.FromArgb(184,184,184)))
              g.DrawString("Helix desktop control",font,brush,new PointF(305,230));
            g.DrawImageUnscaled(gold,0,0);
          }
          backdrop.Save(output,System.Drawing.Imaging.ImageFormat.Png);
        }
      }
      return "Gold renderer verified: crisp edge, wide fading halo, richer corners, transparent center, high DPI and pulse. Preview: "+output;
    }
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h,int index);
    static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
    static Dictionary<string,object> Call(StreamReader reader,StreamWriter writer,JavaScriptSerializer json,Dictionary<string,object> command) {
      command["id"]=Guid.NewGuid().ToString();writer.WriteLine(json.Serialize(command));
      while(true) {
        var read=reader.ReadLineAsync();if(!read.Wait(8000))throw new Exception("Native helper response timed out.");
        var r=json.Deserialize<Dictionary<string,object>>(read.Result);if(r.ContainsKey("event"))continue;
        Require(Convert.ToBoolean(r["ok"]),r.ContainsKey("error")?Convert.ToString(r["error"]):"native request failed");return r;
      }
    }
    public static string Run(bool exercise,string previewPath,bool viewerOnly=false) {
      string pipeName="helix-computer-"+Guid.NewGuid(),secret=Guid.NewGuid().ToString();
      Exception workerError=null;Form scratch=null;TextBox input=null;int clicks=0;IntPtr scratchHandle=IntPtr.Zero;
      var thread=new Thread(()=>{try{Worker.Run(pipeName,secret);}catch(Exception e){workerError=e;}});thread.SetApartmentState(ApartmentState.STA);thread.IsBackground=true;thread.Start();
      Thread scratchThread=null;
      try {
        using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)) {
          pipe.Connect(6000);
          using(var reader=new StreamReader(pipe,new UTF8Encoding(false),false,65536,true))
          using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),65536,true){AutoFlush=true}) {
            var json=new JavaScriptSerializer{MaxJsonLength=24*1024*1024};
            Call(reader,writer,json,new Dictionary<string,object>{{"op","hello"},{"secret",secret}});
            var info=Call(reader,writer,json,new Dictionary<string,object>{{"op","info"}});
            var monitors=(object[])info["monitors"];
            if(viewerOnly) {
              Call(reader,writer,json,new Dictionary<string,object>{{"op","start"}});
              int packets=0;
              foreach(var value in monitors) {
                var monitor=(Dictionary<string,object>)value;
                Call(reader,writer,json,new Dictionary<string,object>{{"op","capture"},{"monitorId",monitor["id"]}});
                using(var udp=new System.Net.Sockets.UdpClient(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback,0))) {
                  udp.Client.ReceiveTimeout=5000;
                  int port=((System.Net.IPEndPoint)udp.Client.LocalEndPoint).Port;
                  Call(reader,writer,json,new Dictionary<string,object>{{"op","viewer_start"},{"port",port}});
                  for(int n=0;n<40;n++) {var from=new System.Net.IPEndPoint(System.Net.IPAddress.Any,0);var packet=udp.Receive(ref from);Require(packet.Length>12&&(packet[1]&127)==96,"Expected H264 RTP.");packets++;}
                  Call(reader,writer,json,new Dictionary<string,object>{{"op","viewer_stop"}});
                }
              }
              Call(reader,writer,json,new Dictionary<string,object>{{"op","stop"}});
              Require(OverlayCount()==0,"Overlay remained after stop.");
              return json.Serialize(new {ok=true,monitorCount=monitors.Length,rtpPackets=packets,checks="Actual desktop encoder on each monitor; stop clears overlays. No input sent."});
            }
            if(!exercise)return json.Serialize(new {ok=true,monitors=monitors,available=info["available"],mode="observation only"});
            Require(Convert.ToBoolean(info["available"]),"Desktop unavailable. Unlock Windows first.");
            var ready=new ManualResetEvent(false);
            scratchThread=new Thread(()=>{
              Win.SetThreadDpiAwarenessContext(new IntPtr(-4));
              scratch=new Form{Text="Helix desktop test — disposable scratch window",StartPosition=FormStartPosition.Manual,Location=Screen.PrimaryScreen.Bounds.Location,Size=new Size(640,360),BackColor=Color.FromArgb(13,14,15),TopMost=true};
              input=new TextBox{Multiline=true,Location=new Point(24,70),Size=new Size(570,180),BackColor=Color.FromArgb(26,25,23),ForeColor=Color.FromArgb(249,225,136),Font=new Font("Segoe UI",14)};
              var button=new Button{Text="Test click",Location=new Point(24,270),Size=new Size(150,40)};button.Click+=(s,e)=>clicks++;
              scratch.Controls.Add(input);scratch.Controls.Add(button);
              scratch.Shown+=(s,e)=>{scratchHandle=scratch.Handle;input.Focus();ready.Set();};Application.Run(scratch);
            });scratchThread.SetApartmentState(ApartmentState.STA);scratchThread.IsBackground=true;scratchThread.Start();Require(ready.WaitOne(5000),"Scratch window failed to open.");
            scratch.Invoke(new Action(()=>{scratch.Activate();input.Focus();SetForegroundWindow(scratch.Handle);}));Thread.Sleep(200);
            var before=Call(reader,writer,json,new Dictionary<string,object>{{"op","info"}});
            var window=(Dictionary<string,object>)before["activeWindow"];
            Require(Convert.ToString(window["handle"])==scratchHandle.ToInt64().ToString(),"Scratch window did not get focus; no input sent.");
            var started=Call(reader,writer,json,new Dictionary<string,object>{{"op","start"},{"label",true},{"pulse",true}});
            var primary=(Dictionary<string,object>)Array.Find(monitors,m=>Convert.ToBoolean(((Dictionary<string,object>)m)["primary"]));
            Require(primary!=null,"No primary monitor reported.");
            Require(Convert.ToString(started["monitorId"])==Convert.ToString(primary["id"]),"Control should start on the active scratch-window monitor.");
            Require(OverlayCount()==1,"A single-screen task must light only the active monitor.");
            var shot=Call(reader,writer,json,new Dictionary<string,object>{{"op","capture"},{"monitorId","all"},{"maxEdge",1200}});
            using(var bytes=new MemoryStream(Convert.FromBase64String((string)shot["image"])))
            using(var bitmap=Image.FromStream(bytes))Require(bitmap.Width==Convert.ToInt32(shot["width"]),"Invalid screenshot dimensions.");
            var forms=Overlays();
            Require(forms.Count==monitors.Length,"Must have one overlay per monitor.");
            foreach(var f in forms)f.Invoke(new Action(()=>{
              int style=GetWindowLong(f.Handle,-20);Require((style&0x80020)==0x80020,"Overlay must be layered and click-through.");
              Require((style&0x08000000)!=0,"Overlay must not activate.");Require((style&8)!=0,"Overlay must be topmost.");
              Require(f.Visible,"Overlay must be visible before input.");
              if(previewPath!="")Win.SetWindowDisplayAffinity(f.Handle,0); // QA only: include the border in a scratch-window crop.
            }));
            if(previewPath!="") {
              Thread.Sleep(100);var previewBounds=Screen.PrimaryScreen.Bounds;
              using(var preview=new Bitmap(600,300)){using(var g=Graphics.FromImage(preview))g.CopyFromScreen(previewBounds.Location,Point.Empty,preview.Size);preview.Save(previewPath,System.Drawing.Imaging.ImageFormat.Png);}
            }
            if(monitors.Length>1) {
              var secondary=(Dictionary<string,object>)Array.Find(monitors,m=>!Convert.ToBoolean(((Dictionary<string,object>)m)["primary"]));
              var alternate=Call(reader,writer,json,new Dictionary<string,object>{{"op","capture"},{"monitorId",secondary["id"]}});
              Require(Convert.ToString(alternate["monitorId"])==Convert.ToString(secondary["id"]),"Second-monitor capture selected the wrong screen.");
              Require(OverlayCount()==1&&Overlays()[0].MonitorId==Convert.ToString(secondary["id"]),"Indicator must follow the second monitor alone.");
            }
            Call(reader,writer,json,new Dictionary<string,object>{{"op","capture"},{"monitorId",primary["id"]}});
            Require(OverlayCount()==1&&Overlays()[0].MonitorId==Convert.ToString(primary["id"]),"Indicator must return to the primary monitor alone.");
            string expected=scratchHandle.ToInt64().ToString();
            var typed=Call(reader,writer,json,new Dictionary<string,object>{{"op","action"},{"kind","type_text"},{"text","Helix gold — سلام"},{"layout",shot["layout"]},{"expectedWindow",expected},{"settleMs",100}});
            Thread.Sleep(100);string contents="";scratch.Invoke(new Action(()=>contents=input.Text));Require(contents=="Helix gold — سلام","Unicode text entry failed.");
            var next=Call(reader,writer,json,new Dictionary<string,object>{{"op","capture"}});
            Point buttonPoint=Point.Empty;scratch.Invoke(new Action(()=>buttonPoint=scratch.PointToScreen(new Point(60,290))));
            Call(reader,writer,json,new Dictionary<string,object>{{"op","action"},{"kind","click"},{"x",buttonPoint.X},{"y",buttonPoint.Y},{"layout",next["layout"]},{"settleMs",150}});
            Thread.Sleep(100);Require(clicks==1,"Click did not reach the scratch window through the overlay.");
            var remaining=Overlays();Call(reader,writer,json,new Dictionary<string,object>{{"op","stop"}});
            foreach(var f in forms)Require(f.IsDisposed,"Overlay did not disappear on stop.");
            foreach(var f in remaining)Require(f.IsDisposed,"Active overlay did not disappear on stop.");
            return json.Serialize(new {ok=true,monitorCount=monitors.Length,monitors=monitors,checks=new string[]{"pipe authentication","screen image bytes","active-monitor selection","overview lights both","monitor switching","topmost/click-through/no-activation styles","Unicode typing","click reaches scratch window","stop destroys overlays"},preview=previewPath});
          }
        }
      } finally {
        if(scratch!=null&&!scratch.IsDisposed)try{scratch.Invoke(new Action(()=>scratch.Close()));}catch{}
        if(scratchThread!=null)scratchThread.Join(2000);thread.Join(2500);
        if(workerError!=null)throw new Exception("Native worker failed",workerError);
      }
    }
    static List<GoldOverlay> Overlays(){var result=new List<GoldOverlay>();foreach(Form f in Application.OpenForms)if(f is GoldOverlay)result.Add((GoldOverlay)f);return result;}
    static int OverlayCount(){return Overlays().Count;}
  }
}
