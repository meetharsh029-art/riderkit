import os, cairosvg
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
G="/usr/share/fonts/truetype/sand-box/google/"
OUT="/workspace/rider-app/brand/logos/"
_c={}
def font(f,w=None):
    k=(f,w)
    if k not in _c:
        t=TTFont(G+f)
        if w and 'fvar' in t: t=instancer.instantiateVariableFont(t,{"wght":w})
        _c[k]=t
    return _c[k]
def text(f,w,s,size,track=0,skew=0):
    """returns list of (char,d,x), width"""
    t=font(f,w); gs=t.getGlyphSet(); cmap=t.getBestCmap(); upm=t['head'].unitsPerEm
    sc=size/upm; x=0; res=[]
    for ch in s:
        gn=cmap[ord(ch)]
        pen=SVGPathPen(gs); tp=TransformPen(pen,(sc,0,0,-sc,0,0)); gs[gn].draw(tp)
        res.append((ch,pen.getCommands(),x,gs[gn].width*sc))
        x+=gs[gn].width*sc+track
    return res,x-track
def lum(h):
    h=h.lstrip('#'); r,g,b=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    f=lambda c:c/12.92 if c<=.03928 else ((c+.055)/1.055)**2.4
    return .2126*f(r)+.7152*f(g)+.0722*f(b)
def cr(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+.05)/(lb+.05)

DARKBG="#0B1220"
D={}
# ---------- A: Pathline M
D['A']=dict(slug="a-pathline", name="Pathline M", primary="#1D4ED8", accent="#F97316", pdark="#6EA2FF", adark="#FB923C",
  ink="#0F172A", fonts="Sora (wordmark) + Inter (UI)")
def iconA(p,a):
    return (f'<path d="M26 74 V36 C26 27 35 26 40 33 L50 49 L60 33 C65 26 74 27 74 36 V74" fill="none" stroke="{p}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="74" cy="74" r="0" fill="{a}"/><path d="M50 60 V74" stroke="{a}" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 9"/>'
            f'<circle cx="50" cy="68" r="4.5" fill="{a}"/>')
def wordA(p,a,ink,h=100):
    r,w=text("Sora/Sora-VariableFont_wght.ttf",700,"malhiva",52,-1)
    ic=iconA(p,a)
    d="".join(f'<path d="{dd}" transform="translate({x+100},{70})"/>' for ch,dd,x,_ in r)
    return 100+w+20, f'<g transform="translate(0,0) scale(1)">{ic}</g><g fill="{ink}">{d}</g>'
# ---------- B: custom iva wordmark
D['B']=dict(slug="b-wordmark-iva", name="Custom 'iva' Wordmark", primary="#0F172A", accent="#F59E0B", pdark="#F8FAFC", adark="#FBBF24",
  ink="#0F172A", fonts="Outfit (wordmark) + Manrope (UI)")
def iconB(p,a):
    r,w=text("Outfit/Outfit-VariableFont_wght.ttf",700,"m",96)
    ox=50-w/2
    d=r[0][1]
    return (f'<path d="{d}" transform="translate({ox},73)" fill="{p}"/>'
            f'<circle cx="{ox+w*0.5-0.5}" cy="25" r="6.5" fill="{a}"/>')
def wordB(p,a,ink):
    f="Outfit/Outfit-VariableFont_wght.ttf"
    r1,w1=text(f,600,"mal",72,0)
    r2,w2=text(f,600,"h",72,0)
    # build "malh" in ink then dotless i + v + a in accent-ish
    rr,ww=text(f,600,"malhıva",72,0)
    parts=""; 
    for ch,dd,x,adv in rr:
        col=ink if ch in "malh" else p if False else a if ch=="v" else ink
        if ch=="ı":
            parts+=f'<path d="{dd}" transform="translate({x+10},80)" fill="{ink}"/><circle cx="{x+10+adv/2}" cy="26" r="8" fill="{a}"/>'
        elif ch=="v":
            parts+=f'<path d="{dd}" transform="translate({x+10},80)" fill="{a if a else ink}"/>'
        else:
            parts+=f'<path d="{dd}" transform="translate({x+10},80)" fill="{ink}"/>'
    # swoosh underline under "iva": rider line
    xi=[x for ch,dd,x,adv in rr if ch=="ı"][0]
    parts+=f'<path d="M{xi+10} 94 H{ww+10}" stroke="{a}" stroke-width="5" stroke-linecap="round" />'
    return ww+20, parts
# ---------- C: Helmet badge
D['C']=dict(slug="c-visor-badge", name="Visor Badge", primary="#0F766E", accent="#84CC16", pdark="#2DD4BF", adark="#A3E635",
  ink="#0B1F1D", fonts="Space Grotesk (wordmark) + Inter (UI)")
def iconC(p,a):
    return (f'<circle cx="50" cy="50" r="40" fill="none" stroke="{p}" stroke-width="7"/>'
            f'<path d="M30 64 V38 L50 56 L70 38 V64" fill="none" stroke="{p}" stroke-width="8" stroke-linejoin="miter" stroke-linecap="butt"/>'
            f'<path d="M26 75 Q50 84 74 75" fill="none" stroke="{a}" stroke-width="5" stroke-linecap="round"/>')
def wordC(p,a,ink):
    r,w=text("Space Grotesk/SpaceGrotesk-VariableFont_wght.ttf",700,"MALHIVA",46,9)
    d="".join(f'<path d="{dd}" transform="translate({x+112},66)"/>' for ch,dd,x,_ in r)
    return 112+w+10, f'<g>{iconC(p,a)}</g><g fill="{ink}">{d}</g><rect x="112" y="76" width="{w}" height="4" fill="{a}"/>'
# ---------- D: Italic peak M
D['D']=dict(slug="d-apex-m", name="Apex M (angular italic)", primary="#C8102E", accent="#111827", pdark="#FF4D63", adark="#F3F4F6",
  ink="#111827", fonts="Barlow Condensed (wordmark) + Barlow (UI)")
def iconD(p,a):
    return (f'<g transform="translate(50 50) skewX(-12) translate(-50 -50)">'
            f'<path d="M24 76 V26 L50 56 L76 26 V76" fill="none" stroke="{p}" stroke-width="13" stroke-linejoin="miter" stroke-miterlimit="10"/>'
            f'<path d="M44 78 L50 68 L56 78 Z" fill="{a}"/></g>')
def wordD(p,a,ink):
    r,w=text("Barlow Condensed/BarlowCondensed-ExtraBoldItalic.ttf",None,"MALHIVA",78,6)
    d="".join(f'<path d="{dd}" transform="translate({x+112},76)"/>' for ch,dd,x,_ in r)
    return 112+w+10, f'<g>{iconD(p,a)}</g><g fill="{ink}">{d}</g>'

ICON={'A':iconA,'B':iconB,'C':iconC,'D':iconD}
WORD={'A':wordA,'B':wordB,'C':wordC,'D':wordD}
def svg(w,h,body,bg=None):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h}" width="{w:.0f}" height="{h}">{b}{body}</svg>'
def icon_tile(k,mode):
    d=D[k]; dark=mode=="dark"
    p,a=(d['pdark'],d['adark']) if dark else (d['primary'],d['accent'])
    bg=DARKBG if dark else "#FFFFFF"; stroke="" if dark else ' stroke="#E5E7EB" stroke-width="1"'
    body=f'<rect x="1" y="1" width="98" height="98" rx="22" fill="{bg}"{stroke}/>'
    # glyph is 100-box; icon-safe zone: scale to 80%
    body+=f'<g transform="translate(10 10) scale(.8)">{ICON[k](p,a)}</g>'
    return svg(100,100,body)
def word_svg(k,mode):
    d=D[k]; dark=mode=="dark"
    p,a=(d['pdark'],d['adark']) if dark else (d['primary'],d['accent'])
    ink="#F8FAFC" if dark else d['ink']
    if k=='A': w,body=wordA(p,a,ink)
    elif k=='B': w,body=wordB(p,a,ink)
    elif k=='C': w,body=wordC(p,a,ink)
    else: w,body=wordD(p,a,ink)
    if k=='B': w+=0; 
    return w,svg(w+40,100+0,f'<g transform="translate(20,0)">{body}</g>',"#0B1220" if dark else "#FFFFFF") , w
rep=[]
for k in 'ABCD':
    s=D[k]['slug']
    for m in('light','dark'):
        open(f"{OUT}{s}-icon-{m}.svg","w").write(icon_tile(k,m))
        w,sv,_=word_svg(k,m)
        open(f"{OUT}{s}-wordmark-{m}.svg","w").write(sv)
    for p,a in (("primary","accent"),):
        rep.append((k,D[k]['primary'],D[k]['accent'],round(cr(D[k]['primary'],'#FFFFFF'),2),round(cr(D[k]['accent'],'#FFFFFF'),2),round(cr(D[k]['pdark'],DARKBG),2),round(cr(D[k]['accent'] if k!='D' else D[k]['accent'],'#FFFFFF'),2)))
print(rep)
# PNGs
import glob
for f in sorted(glob.glob(OUT+"*.svg")):
    sc=6 if "icon" in f else 3
    cairosvg.svg2png(url=f,write_to=f[:-4]+".png",scale=sc)
# comparison sheet
from PIL import Image, ImageDraw, ImageFont
H=ImageFont.truetype(G+"Inter/Inter-VariableFont_opsz,wght.ttf",30)
S=ImageFont.truetype(G+"Inter/Inter-VariableFont_opsz,wght.ttf",18)
W=1800; rowh=330
sheet=Image.new("RGB",(W,rowh*4+110),"#F3F4F6"); dr=ImageDraw.Draw(sheet)
dr.text((40,30),"Malhiva — 4 logo directions (light | dark | app icons 180/60/29px)",font=H,fill="#111827")
for i,k in enumerate('ABCD'):
    y=110+i*rowh; d=D[k]
    dr.text((40,y),f"{k}. {d['name']}  —  {d['primary']} / {d['accent']}",font=H,fill="#111827")
    for j,m in enumerate(('light','dark')):
        im=Image.open(f"{OUT}{d['slug']}-wordmark-{m}.png").convert("RGB")
        im=im.resize((int(im.width*0.55),int(im.height*0.55)),Image.LANCZOS)
        if im.width>520: im=im.resize((520,int(im.height*520/im.width)))
        sheet.paste(im,(40+j*560,y+50))
    for j,m in enumerate(('light','dark')):
        ic=Image.open(f"{OUT}{d['slug']}-icon-{m}.png").convert("RGBA")
        x0=1180+j*300
        bgc=Image.new("RGBA",(280,260),"#FFFFFF" if m=='light' else "#1F2937")
        sheet.paste(bgc.convert("RGB"),(x0-10,y+40))
        for sz,off in ((180,0),(60,190),(29,190)):
            pass
        a=ic.resize((180,180),Image.LANCZOS); sheet.paste(a,(x0,y+50),a)
        b=ic.resize((60,60),Image.LANCZOS); sheet.paste(b,(x0+190-0,y+50),b)
        c=ic.resize((29,29),Image.LANCZOS); sheet.paste(c,(x0+190,y+130),c)
sheet.save("/workspace/rider-app/brand/logo-directions.png")
