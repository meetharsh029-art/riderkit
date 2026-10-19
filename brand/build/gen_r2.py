import sys, math, glob, os
sys.path.insert(0,'/workspace/rider-app/brand/build')
import cairosvg
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image, ImageDraw, ImageFont
G="/usr/share/fonts/truetype/sand-box/google/"
OUT="/workspace/rider-app/brand/logos-r2/"
FONT=G+"Space Grotesk/SpaceGrotesk-VariableFont_wght.ttf"
_t=TTFont(FONT); _t=instancer.instantiateVariableFont(_t,{"wght":700})
def text(s,size,track):
    gs=_t.getGlyphSet(); cm=_t.getBestCmap(); upm=_t['head'].unitsPerEm; sc=size/upm; x=0; r=[]
    for ch in s:
        pen=SVGPathPen(gs); gs[cm[ord(ch)]].draw(TransformPen(pen,(sc,0,0,-sc,0,0)))
        r.append((pen.getCommands(),x)); x+=gs[cm[ord(ch)]].width*sc+track
    return r,x-track
def lum(h):
    h=h.lstrip('#'); f=lambda c:c/12.92 if c<=.03928 else ((c+.055)/1.055)**2.4
    r,g,b=[f(int(h[i:i+2],16)/255) for i in (0,2,4)]; return .2126*r+.7152*g+.0722*b
def cr(a,b):
    x,y=sorted([lum(a),lum(b)],reverse=True); return round((x+.05)/(y+.05),2)

def Mpoly(x0=29,x1=71,y0=30,y1=66,t=9,a=9,vd=16,k=14,c=0,eye=None,s=False):
    cx=(x0+x1)/2; yv=y0+vd
    P=[(x0,y1),(x0,y0),(x0+a,y0),(cx,yv),(x1-a,y0),(x1,y0),(x1,y1),(x1-t,y1-c),(x1-t,y0+k),(cx,yv+k),(x0+t,y0+k),(x0+t,y1-c)]
    out='<path d="M'+' L'.join(f'{x:.2f} {y:.2f}' for x,y in P)+' Z"/>'
    if eye:
        # eyes sit in the two lower counters of the M (slanted leaf shapes), nose = V tip between them
        gx=((x0+t)*2+cx)/3; gy=((y0+k)+(yv+k)+(y1-c))/3; gx=gx-0.6
        rx,ry=(2.5,4.3) if not s else (3.4,5.2)
        for sg in (-1,1):
            ex=cx+sg*(cx-gx)+ (sg*0.0); ang=0
            out+=f'<ellipse cx="{ex:.2f}" cy="{gy+0.5:.2f}" rx="{rx}" ry="{ry}" transform="rotate({ang} {ex:.2f} {gy+0.5:.2f})" fill="{eye}"/>'
    return out
def crescent(cx,y,w,r,R,down=True):
    s1,s2=(0,1) if down else (1,0)
    return f'M{cx-w} {y} A{r} {r} 0 0 {s1} {cx+w} {y} A{R} {R} 0 0 {s2} {cx-w} {y}Z'
def polar(r,deg,cx=50,cy=50):
    a=math.radians(deg); return cx+r*math.cos(a),cy+r*math.sin(a)
def arcpath(r,a0,a1):
    x0,y0=polar(r,a0); x1,y1=polar(r,a1); large=1 if (a1-a0)%360>180 else 0
    return f'M{x0:.2f} {y0:.2f} A{r} {r} 0 {large} 1 {x1:.2f} {y1:.2f}'

# glyph builders: c keys ring, m, arc, disc, knock
def g1(c,s):   # Faceted ring: concentric ring, faceted M, smile glint
    o=f'<circle cx="50" cy="50" r="40" fill="none" stroke="{c["ring"]}" stroke-width="{8 if s else 6.5}"/>'
    o+=f'<g fill="{c["m"]}">{Mpoly(x0=30,x1=70,y0=29,y1=64,t=9.5,a=10,vd=16,k=14,c=0,eye=c["arc"],s=s)}</g>'
    o+=f'<path d="{crescent(50,72,19,30,52) if not s else crescent(50,74,21,28,50)}" fill="{c["arc"]}"/>'
    return o
def g2(c,s):   # Navy disc, angled feet, visor glint across lower
    o=f'<circle cx="50" cy="50" r="43" fill="{c["disc"]}"/>'
    o+=f'<g fill="{c["m"]}">{Mpoly(x0=27,x1=73,y0=26,y1=64,t=10,a=10,vd=17,k=15,c=7,eye=c["arc"],s=s)}</g>'
    o+=f'<path d="{crescent(50,72,26,34,70) if not s else crescent(50,73,27,32,56)}" fill="{c["arc"]}"/>'
    return o
def g3(c,s):   # Black horizon: visor arc over M (top), thin ring, wide M
    o=f'<circle cx="50" cy="50" r="41" fill="none" stroke="{c["ring"]}" stroke-width="3"/>' if not s else ''
    o+=f'<g fill="{c["m"]}">{Mpoly(x0=26,x1=74,y0=36,y1=72,t=10.5,a=11,vd=17,k=15,c=0,eye=c["arc"],s=s)}</g>'
    o+=f'<path d="{arcpath(30,205,335)}" fill="none" stroke="{c["arc"]}" stroke-width="{7 if s else 5.5}" stroke-linecap="butt"/>' 
    return o
def g4(c,s):   # open ring with lime glint closing the gap at bottom
    o=f'<path d="{arcpath(40,118,62+360)}" fill="none" stroke="{c["ring"]}" stroke-width="{8 if s else 6}" stroke-linecap="round"/>'
    o+=f'<g fill="{c["m"]}">{Mpoly(x0=29,x1=71,y0=27,y1=64,t=9,a=9,vd=16,k=14,c=5,eye=c["arc"],s=s)}</g>'
    o+=f'<path d="{crescent(50,84,13,17,34) if not s else crescent(50,85,15,16,26)}" fill="{c["arc"]}"/>'
    return o
def g5(c,s):   # shield/hex badge
    sh="M50 7 L86 21 V52 C86 72 70 85 50 94 C30 85 14 72 14 52 V21 Z"
    o=f'<path d="{sh}" fill="{c["disc"]}" stroke="{c.get("edge","none")}" stroke-width="3" stroke-linejoin="round"/>'
    o+=f'<g fill="{c["m"]}">{Mpoly(x0=28,x1=72,y0=26,y1=60,t=10,a=10,vd=16,k=14.5,c=6,eye=c["arc"],s=s)}</g>'
    o+=f'<path d="{crescent(50,69,17,24,46) if not s else crescent(50,70,19,22,36)}" fill="{c["arc"]}"/>'
    return o
V=[
 dict(id=1,slug="c1-faceted-ring",name="Faceted Ring",fn=g1,
  light=dict(ring="#0F766E",m="#0F766E",arc="#84CC16"),dark=dict(ring="#2DD4BF",m="#2DD4BF",arc="#A3E635"),
  tl="#FFFFFF",td="#0B1F1D",ink="#0B1F1D",mono="#0F766E",bgad="#FFFFFF",bgad_d="#0B1F1D",
  pal="Teal #0F766E + lime #84CC16 (ink #0B1F1D)",
  note="Closest to round 1: ring + faceted M with parallel diagonals, lime smile glint concentric to the ring."),
 dict(id=2,slug="c2-navy-disc",name="Navy Disc",fn=g2,
  light=dict(disc="#0B2447",m="#FFFFFF",arc="#2DD4BF"),dark=dict(disc="#16396E",m="#FFFFFF",arc="#5EEAD4"),
  tl="#FFFFFF",td="#07101F",ink="#0B2447",mono="#0B2447",bgad="#0B2447",bgad_d="#07101F",
  pal="Deep navy #0B2447 + teal #2DD4BF glint + white",
  note="Solid disc (strongest at 16-32px), angled-foot M, wide teal visor glint. Reads as a screen/button."),
 dict(id=3,slug="c3-black-horizon",name="Black Horizon",fn=g3,
  light=dict(ring="#3F3F46",m="#FFFFFF",arc="#84CC16"),dark=dict(ring="#52525B",m="#FFFFFF",arc="#A3E635"),
  tl="#0A0A0A",td="#0A0A0A",ink="#0A0A0A",mono="#0A0A0A",bgad="#0A0A0A",bgad_d="#0A0A0A",
  pal="Black #0A0A0A + lime #84CC16 + white",
  note="Visor arc sits above a wide, low M like a horizon/brim; premium hardware feel; icon tile is full-bleed black."),
 dict(id=4,slug="c4-open-ring",name="Open Ring",fn=g4,
  light=dict(ring="#115E59",m="#115E59",arc="#84CC16"),dark=dict(ring="#2DD4BF",m="#2DD4BF",arc="#A3E635"),
  tl="#FFFFFF",td="#052E2B",ink="#042F2E",mono="#115E59",bgad="#FFFFFF",bgad_d="#052E2B",
  pal="Deep teal #115E59 + lime #84CC16",
  note="Ring is open at the bottom and the lime glint closes the gap like a road meeting the horizon; most distinctive silhouette."),
 dict(id=5,slug="c5-shield-badge",name="Shield Badge",fn=g5,
  light=dict(disc="#0B2447",m="#FFFFFF",arc="#84CC16"),dark=dict(disc="#16396E",m="#FFFFFF",arc="#A3E635",edge="#5EEAD4"),
  tl="#FFFFFF",td="#060E1D",ink="#0B2447",mono="#0B2447",bgad="#FFFFFF",bgad_d="#060E1D",
  pal="Navy #0B2447 + lime #84CC16 + white (teal #0F766E UI link colour)",
  note="Bike/tank-badge shape (shield) rather than circle; best on a bike, wider ownable silhouette, weaker as a circular button."),
]
def mono(v):  # one colour; fills knocked out in white
    m=v['mono']
    if v['id'] in (2,5): return dict(disc=m,m="#FFFFFF",arc="#FFFFFF",ring=m)
    if v['id']==3: return dict(ring=m,m=m,arc=m)
    return dict(ring=m,m=m,arc=m)
def svgw(w,h,body,bg=None,vb=None):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb or f"0 0 {w} {h}"}" width="{w}" height="{h}">{b}{body}</svg>'
def tile(v,mode,s=False,size=100):
    c=v['light'] if mode=='light' else v['dark']; bg=v['tl'] if mode=='light' else v['td']
    st=' stroke="#E5E7EB"' if bg=="#FFFFFF" else ''
    body=f'<rect x=".5" y=".5" width="99" height="99" rx="22"{st} fill="{bg}"/><g transform="translate(10 10) scale(.8)">{v["fn"](c,s)}</g>'
    return svgw(size,size,body,vb="0 0 100 100")
def bare(v,mode,s=False,m=False):
    c=mono(v) if m else (v['light'] if mode=='light' else v['dark']); return v['fn'](c,s)
def wordmark(v,mode):
    c=v['light'] if mode=='light' else v['dark']; dark=mode=='dark'
    r,w=text("MALHIVA",46,9); ink="#F8FAFC" if dark else v['ink']
    d="".join(f'<path d="{dd}" transform="translate({x+124},66)"/>' for dd,x in r)
    acc=c['arc']
    body=f'<g transform="translate(6 0)">{v["fn"](c,False)}</g><g fill="{ink}">{d}</g><rect x="124" y="77" width="{w*0.28:.1f}" height="4" fill="{acc}"/>'
    W=124+w+30
    return svgw(round(W),100,body,"#0B1220" if dark else "#FFFFFF",vb=f"0 0 {W:.0f} 100")
def monoword(v):
    r,w=text("MALHIVA",46,9); m=v['mono']
    d="".join(f'<path d="{dd}" transform="translate({x+124},66)"/>' for dd,x in r)
    W=124+w+30
    return svgw(round(W),100,f'<g transform="translate(6 0)">{bare(v,"light",False,True)}</g><g fill="{m}">{d}</g>',"#FFFFFF",vb=f"0 0 {W:.0f} 100")
def adaptive(v,mode,which):
    s=0.76; off=(108-100*s)/2
    c=v['light'] if mode=='light' else v['dark']
    if which=='bg':
        return svgw(108,108,'',v['bgad'] if mode=='light' else v['bgad_d'])
    if which=='fg':
        return svgw(108,108,f'<g transform="translate({off} {off}) scale({s})">{v["fn"](c,False)}</g>')
    if which=='mono':  # themed icon: single-colour silhouette, black, transparent
        mc=dict(disc="#000",m="#000",arc="#000",ring="#000")
        return svgw(108,108,f'<g transform="translate({off} {off}) scale({s})">{v["fn"](mc,False)}</g>')
def adaptive_preview(v):
    S=216; im=Image.new("RGB",(S*4+50,S+20),"#E5E7EB")
    for i,shape in enumerate(("circle","squircle","square","guides")):
        bg=Image.open(io_png(adaptive(v,'light','bg'),S)).convert("RGBA"); fg=Image.open(io_png(adaptive(v,'light','fg'),S)).convert("RGBA")
        t=Image.alpha_composite(bg,fg); mask=Image.new("L",(S,S),0); d=ImageDraw.Draw(mask)
        if shape=="circle": d.ellipse((0,0,S-1,S-1),fill=255)
        elif shape=="squircle": d.rounded_rectangle((0,0,S-1,S-1),radius=int(S*.3),fill=255)
        else: d.rectangle((0,0,S,S),fill=255)
        if shape=="guides":
            t2=t.copy(); dd=ImageDraw.Draw(t2); dd.ellipse((S*21/108,S*21/108,S*87/108,S*87/108),outline="#EF4444",width=2)
            dd.rectangle((0,0,S-1,S-1),outline="#3B82F6",width=2); im.paste(t2.convert("RGB"),(10+i*(S+10),10))
        else: im.paste(t.convert("RGB"),(10+i*(S+10),10),mask)
    return im
def io_png(svg,px):
    import io; return io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(),output_width=px,output_height=px))
def png(svg,px): return Image.open(io_png(svg,px)).convert("RGBA")
def sizes(v):
    W=760; im=Image.new("RGB",(W,330),"#FFFFFF"); d=ImageDraw.Draw(im)
    F=ImageFont.truetype(G+"Inter/Inter-VariableFont_opsz,wght.ttf",13)
    x=14
    for row,mode,bg in ((0,'light',"#FFFFFF"),(1,'dark',"#111827")):
        y=10+row*160; d.rectangle((0,y-6,W,y+150),fill=bg); x=14
        for px in (16,32,48,192):
            t=png(tile(v,mode,s=px<=32),px)
            if px<192: im.paste(t,(x,y),t); 
            else: im.paste(t,(x,y-4),t)
            # 4x nearest zoom for small ones
            if px<=48:
                z=t.resize((px*3,px*3),Image.NEAREST); im.paste(z,(x,y+54 if px<=32 else y+54),z) if px<=32 else None
            d.text((x,y+148-16),f"{px}px"+(" (simplified)" if px<=32 else ""),font=F,fill="#9CA3AF")
            x+= max(px,96 if px<=32 else px)+ (60 if px<192 else 0)+ (30 if px<=32 else 0)
    return im
def helmet_mock(v):
    c=v['light']; w=v['mono']
    badge=v['fn'](c,False)
    bg=v['bgad'] if v['id'] not in (1,4) else "#E8EDEC"
    shell="#F3F4F6" if v['id'] in (2,3,5) else "#0F1F1E"
    ink="#FFFFFF"
    # helmet side profile (own drawing, generic)
    helm=f'''<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{shell}"/><stop offset="1" stop-color="{'#C9CED6' if shell=='#F3F4F6' else '#000'}"/></linearGradient>
    <linearGradient id="vz" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0B1220"/><stop offset="1" stop-color="#334155"/></linearGradient>
    <linearGradient id="mt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8FAFC"/><stop offset=".45" stop-color="#9CA3AF"/><stop offset="1" stop-color="#E5E7EB"/></linearGradient>
    <linearGradient id="tk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1F2937"/><stop offset="1" stop-color="#030712"/></linearGradient></defs>
    <rect width="900" height="420" fill="#E5E7EB"/>
    <ellipse cx="230" cy="372" rx="150" ry="14" fill="#00000022"/>
    <path d="M70 300 C60 170 130 70 250 66 C355 62 410 130 395 235 L388 300 C388 330 360 345 330 340 L150 336 C100 334 72 322 70 300Z" fill="url(#hg)" stroke="#00000022"/>
    <path d="M250 150 C320 140 395 160 392 215 L240 215 C215 190 222 160 250 150Z" fill="url(#vz)"/>
    <path d="M262 160 C300 154 340 158 375 172" stroke="#FFFFFF55" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M70 300 L388 300" stroke="#00000033" stroke-width="3"/>
    <g transform="translate(110 215) scale(1.0)"><g transform="translate(0 0) scale(.9)"><circle cx="45" cy="45" r="46" fill="{bg if bg!='#FFFFFF' else '#FFFFFF'}" opacity=".0"/>
    <g transform="translate(-5 -5)"><rect x="-8" y="-8" width="116" height="116" rx="58" fill="#FFFFFF" opacity="{'.0' if v['id'] in (2,3,5) else '.0'}"/>{badge}</g></g></g>
    <text x="230" y="404" text-anchor="middle" font-family="Inter,sans-serif" font-size="14" fill="#6B7280">Helmet side decal (vinyl, ~5 cm)</text>
    <path d="M520 150 C540 90 700 80 800 120 C850 140 860 190 830 230 C800 270 600 290 560 270 C520 250 505 190 520 150Z" fill="url(#tk)"/>
    <path d="M550 130 C620 100 740 100 800 128" stroke="#FFFFFF33" stroke-width="6" fill="none" stroke-linecap="round"/>
    <circle cx="670" cy="185" r="62" fill="url(#mt)" stroke="#6B7280" stroke-width="2"/>
    <circle cx="670" cy="185" r="53" fill="{v['bgad_d'] if v['id']!=3 else '#0A0A0A'}"/>
    <g transform="translate({670-40} {185-40}) scale(.8)">{v['fn'](v['dark'] if v['id'] in (1,4) else v['dark'],False)}</g>
    <text x="670" y="404" text-anchor="middle" font-family="Inter,sans-serif" font-size="14" fill="#6B7280">Bike tank badge (die-cast metal + enamel)</text>'''
    return svgw(900,420,helm)
def write(name,svg_s,px=None):
    open(OUT+name+".svg","w").write(svg_s)
    cairosvg.svg2png(bytestring=svg_s.encode(),write_to=OUT+name+".png",**({'output_width':px} if px else {}))
rows=[]
for v in V:
    s=v['slug']
    for m in('light','dark'):
        write(f"{s}-icon-{m}",tile(v,m),1024)
        write(f"{s}-wordmark-{m}",wordmark(v,m),1800)
        write(f"{s}-icon-{m}-small",tile(v,m,True),1024)
    write(f"{s}-mono-icon",svgw(100,100,f'<g transform="translate(10 10) scale(.8)">{bare(v,"light",False,True)}</g>',"#FFFFFF",vb="0 0 100 100"),1024)
    write(f"{s}-mono-wordmark",monoword(v),1800)
    for which in('bg','fg','mono'):
        write(f"{s}-adaptive-{which}",adaptive(v,'light',which),432)
    write(f"{s}-adaptive-dark-bg",adaptive(v,'dark','bg'),432); write(f"{s}-adaptive-dark-fg",adaptive(v,'dark','fg'),432)
    adaptive_preview(v).save(OUT+f"{s}-adaptive-preview.png")
    sizes(v).save(OUT+f"{s}-size-test.png")
    write(f"{s}-mock-helmet-bike",helmet_mock(v),1800)
    c=v['light']; dk=v['dark']
    rows.append((v['id'],v['name'],v['pal'],
      cr(c.get('ring',c.get('disc')) if v['id'] in(1,4) else v['tl'] if v['id']==3 else c['disc'],"#FFFFFF") if v['id']!=3 else cr("#0A0A0A","#FFFFFF"),
      cr(c['arc'],"#FFFFFF"),
      cr(c['arc'], {1:'#FFFFFF',2:c.get('disc'),3:'#0A0A0A',4:'#FFFFFF',5:c.get('disc')}[v['id']] or '#FFFFFF'),
      cr(c['m'] if v['id'] in (1,4) else "#FFFFFF", c.get('disc') or '#FFFFFF' if v['id'] in(2,5) else v['tl'] if v['id']==3 else '#FFFFFF'),
      cr(dk['m'] if v['id'] in (1,4) else "#FFFFFF", v['td'] if v['id'] in (1,4,3) else dk.get('disc'))))
for r in rows: print(r)
import json; json.dump(rows,open('/workspace/rider-app/brand/build/r2_contrast.json','w'))

from PIL import ImageFilter
def glance(v):
    im=Image.new("RGB",(640,230),"#FFFFFF"); d=ImageDraw.Draw(im); Fi=ImageFont.truetype(G+"Inter/Inter-VariableFont_opsz,wght.ttf",13)
    x=10
    for mode,bg in(('light',"#FFFFFF"),('dark',"#111827")):
        d.rectangle((x-6,0,x+300,230),fill=bg)
        t=png(tile(v,mode,True),24); im.paste(t,(x,14),t)
        t3=png(tile(v,mode,True),72); im.paste(t3,(x+40,14),t3)
        t4=png(tile(v,mode,True),40); im.paste(t4,(x+125,14),t4)
        b=png(tile(v,mode,False),110).filter(ImageFilter.GaussianBlur(3.5)); im.paste(b,(x+175,14),b)
        t5=png(tile(v,mode,False),96); im.paste(t5,(x+175,130),t5) if False else None
        d.text((x,206),"24px, 24px x3, 40px, blurred squint",font=Fi,fill="#9CA3AF" if mode=='dark' else "#6B7280")
        x+=320
    return im
def closeup(v):
    c=dict(v['light']); bgc=v['tl'] if v['id'] not in(2,5) else v['light']['disc']
    big=png(tile(v,'light'),360)
    c2=dict(c); c2['arc']=c.get('disc') or v['tl']
    if v['id']==3: c2['arc']=v['tl']
    if v['id'] in(1,4): c2['arc']="#FFFFFF"
    t2=tile(v,'light'); 
    # M-only: same glyph but eyes/arc painted in ground colour
    sv=svgw(100,100,f'<rect x=".5" y=".5" width="99" height="99" rx="22" fill="{v["tl"]}" stroke="#E5E7EB"/><g transform="translate(10 10) scale(.8)">{v["fn"](c2,False)}</g>',vb="0 0 100 100")
    m=png(sv,360)
    im=Image.new("RGB",(740,380),"#FFFFFF"); im.paste(big,(0,10),big); im.paste(m,(375,10),m); return im
for v in V:
    glance(v).save(OUT+v['slug']+"-glance-test.png"); closeup(v).save(OUT+v['slug']+"-closeup-M.png")

# comparison sheet
F=lambda s,w=600:ImageFont.truetype(G+"Inter/Inter-VariableFont_opsz,wght.ttf",s)
RH=1010; W=2400
sheet=Image.new("RGB",(W,110+RH*5),"#F3F4F6"); d=ImageDraw.Draw(sheet)
d.text((40,28),"Malhiva — Direction C (Visor Badge) round 2: face-at-a-glance, M-up-close, five refinements",font=F(38),fill="#111827")
d.text((40,76),"Cols: wordmark lockup · icon light/dark/mono · adaptive (circle/squircle/safe-zone) · size test 16/32/48/192 · helmet decal + bike badge mock",font=F(18),fill="#6B7280")
for i,v in enumerate(V):
    y=110+i*RH; s=v['slug']
    d.rectangle((20,y,W-20,y+RH-14),fill="#FFFFFF")
    d.text((40,y+12),f"C{v['id']}  {v['name']}",font=F(30),fill="#111827")
    d.text((40,y+52),v['pal'],font=F(16),fill="#4B5563")
    d.text((40,y+76),v['note'],font=F(14),fill="#6B7280")
    wl=Image.open(OUT+f"{s}-wordmark-light.png").convert("RGB"); wl=wl.resize((560,int(wl.height*560/wl.width)))
    wd=Image.open(OUT+f"{s}-wordmark-dark.png").convert("RGB"); wd=wd.resize((560,int(wd.height*560/wd.width)))
    wm=Image.open(OUT+f"{s}-mono-wordmark.png").convert("RGB"); wm=wm.resize((560,int(wm.height*560/wm.width)))
    sheet.paste(wl,(40,y+110)); sheet.paste(wd,(40,y+110+wl.height+8)); sheet.paste(wm,(40,y+110+2*wl.height+16))
    x=640
    for nm in ("icon-light","icon-dark","mono-icon"):
        im=Image.open(OUT+f"{s}-{nm}.png").convert("RGBA").resize((190,190),Image.LANCZOS); bgc="#E5E7EB" if nm!="icon-dark" else "#E5E7EB"
        sheet.paste(im,(x,y+110),im); x+=205
    ap=Image.open(OUT+f"{s}-adaptive-preview.png"); ap=ap.resize((int(ap.width*.52),int(ap.height*.52)),Image.LANCZOS); sheet.paste(ap,(640,y+320))
    st=Image.open(OUT+f"{s}-size-test.png"); st=st.resize((int(st.width*.78),int(st.height*.78)),Image.LANCZOS); sheet.paste(st,(1290,y+110)) if False else None
    sheet.paste(st.resize((600,int(st.height*600/st.width))),(1290,y+110))
    mk=Image.open(OUT+f"{s}-mock-helmet-bike.png").convert("RGB"); mk=mk.resize((480,int(mk.height*480/mk.width))); 
    sheet.paste(mk,(1290,y+110+int(st.height*600/st.width)+30))
    gl=Image.open(OUT+f"{s}-glance-test.png"); gl=gl.resize((500,int(gl.height*500/gl.width))); sheet.paste(gl,(640,y+450))
    cu=Image.open(OUT+f"{s}-closeup-M.png"); cu=cu.resize((330,int(cu.height*330/cu.width))); sheet.paste(cu,(1290+0,y+450+0)) if False else None
    cu=cu.resize((620,int(cu.height*620/cu.width))); sheet.paste(cu,(640,y+672))
    d.text((640,y+437),"Face glance test (face first)",font=F(13),fill="#6B7280"); d.text((640,y+656),"Close-up: full | M only (eyes + smile removed)",font=F(13),fill="#6B7280")
    # contrast
    r=rows[i]; d.text((1930,y+112),"Contrast (WCAG)",font=F(18),fill="#111827")
    for j,t in enumerate([f"primary/ink vs white: {r[3]}:1",f"accent vs white: {r[4]}:1 (graphic only)",f"accent on badge/tile: {r[5]}:1",f"M on its ground (light): {r[6]}:1",f"M on its ground (dark): {r[7]}:1"]):
        d.text((1930,y+146+j*26),t,font=F(15),fill="#374151")
sheet.save("/workspace/rider-app/brand/logo-c-round2.png")
