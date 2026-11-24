#!/usr/bin/env python3
"""Independent X11 consumer for the isolated generated-track verifier.
Never redirect, map, draw into, or modify the observed windows. The caller must
supply XIDs on its private Xvfb server; no application account or screen capture
permission is acquired. The scene mode compares only the verifier's own client.
"""
import collections
import ctypes as C
import hashlib
import json
import sys

X = C.CDLL('libX11.so.6')
Composite = C.CDLL('libXcomposite.so.1')
Shape = C.CDLL('libXext.so.6')
P = C.c_void_p
U = C.c_ulong
I = C.c_int
UI = C.c_uint

class Image(C.Structure):
    _fields_ = [('width',I),('height',I),('xoffset',I),('format',I),('data',P),
                ('byte_order',I),('bitmap_unit',I),('bitmap_bit_order',I),('bitmap_pad',I),
                ('depth',I),('bytes_per_line',I),('bits_per_pixel',I)]

X.XOpenDisplay.argtypes=[C.c_char_p]; X.XOpenDisplay.restype=P
X.XCloseDisplay.argtypes=[P]
X.XDefaultRootWindow.argtypes=[P]; X.XDefaultRootWindow.restype=U
X.XSync.argtypes=[P,I]
X.XGetGeometry.argtypes=[P,U,C.POINTER(U),C.POINTER(I),C.POINTER(I),C.POINTER(UI),C.POINTER(UI),C.POINTER(UI),C.POINTER(UI)]
X.XQueryTree.argtypes=[P,U,C.POINTER(U),C.POINTER(U),C.POINTER(C.POINTER(U)),C.POINTER(UI)]
X.XFree.argtypes=[P]
X.XFreePixmap.argtypes=[P,U]
X.XGetImage.argtypes=[P,U,I,I,UI,UI,U,I]; X.XGetImage.restype=C.POINTER(Image)
X.XDestroyImage.argtypes=[C.POINTER(Image)]
X.XTranslateCoordinates.argtypes=[P,U,U,I,I,C.POINTER(I),C.POINTER(I),C.POINTER(U)]
Composite.XCompositeNameWindowPixmap.argtypes=[P,U]; Composite.XCompositeNameWindowPixmap.restype=U
Shape.XShapeGetRectangles.argtypes=[P,U,I,C.POINTER(I),C.POINTER(I)]; Shape.XShapeGetRectangles.restype=P
errors=[]
@C.CFUNCTYPE(I,P,P)
def on_error(display, event):
    errors.append(True)
    return 0
X.XSetErrorHandler.argtypes=[C.CFUNCTYPE(I,P,P)]; X.XSetErrorHandler(on_error)


def geometry(display, window):
    root=U(); x=I(); y=I(); w=UI(); h=UI(); border=UI(); depth=UI()
    errors.clear()
    ok=X.XGetGeometry(display,window,C.byref(root),C.byref(x),C.byref(y),C.byref(w),C.byref(h),C.byref(border),C.byref(depth))
    X.XSync(display,0)
    if not ok or errors: return None
    return dict(root=root.value,x=x.value,y=y.value,width=w.value,height=h.value,depth=depth.value)


def tree(display, window):
    root=U(); parent=U(); children=C.POINTER(U)(); count=UI()
    errors.clear()
    ok=X.XQueryTree(display,window,C.byref(root),C.byref(parent),C.byref(children),C.byref(count))
    X.XSync(display,0)
    if not ok or errors: return None
    result=dict(root=root.value,parent=parent.value,children=[children[i] for i in range(count.value)])
    if children: X.XFree(children)
    return result


def image(display, drawable, x, y, width, height):
    errors.clear()
    data=X.XGetImage(display,drawable,x,y,width,height,0xffffffff,2)
    X.XSync(display,0)
    if errors or not data: return None
    try:
        head=data.contents
        if head.bits_per_pixel!=32 or head.byte_order!=0: raise RuntimeError('unsupported consumer pixel format')
        raw=C.string_at(head.data,head.bytes_per_line*head.height)
        rgb=bytearray(width*height*3)
        at=0
        for row in range(height):
            for col in range(width):
                base=row*head.bytes_per_line+col*4
                rgb[at:at+3]=bytes((raw[base+2],raw[base+1],raw[base])); at+=3
        counts=collections.Counter(tuple(rgb[p:p+3]) for p in range(0,len(rgb),3))
        dominant,count=counts.most_common(1)[0]
        changed=sum(n for color,n in counts.items() if max(abs(a-b) for a,b in zip(color,dominant))>8)
        return dict(sha256=hashlib.sha256(rgb).hexdigest(),dominant=list(dominant),dominantCount=count,
                    distinctColors=len(counts),nonSolidPixels=changed,pixels=width*height)
    finally: X.XDestroyImage(data)


request=json.loads(sys.argv[1])
display=X.XOpenDisplay(None)
if not display: raise RuntimeError('No isolated X11 display')
try:
    root=X.XDefaultRootWindow(display)
    result={'rootChildren':sorted(tree(display,root)['children']),'windows':[]}
    for window in request.get('xids',[]):
        g=geometry(display,window); ancestry=tree(display,window) if g else None
        item={'xid':window,'exists':bool(ancestry)}
        if ancestry:
            item.update(g); item['parent']=ancestry['parent']
            n=I(); ordering=I(); rects=Shape.XShapeGetRectangles(display,window,2,C.byref(n),C.byref(ordering))
            item['inputRectangles']=n.value
            if rects: X.XFree(rects)
            if request.get('pixels',True):
                pixmap=Composite.XCompositeNameWindowPixmap(display,window); X.XSync(display,0)
                if not pixmap or errors: raise RuntimeError('Window has no genuine Composite backing pixmap')
                try: item['image']=image(display,pixmap,0,0,g['width'],g['height'])
                finally: X.XFreePixmap(display,pixmap)
                item['directImage']=image(display,window,0,0,g['width'],g['height'])
        result['windows'].append(item)
    if 'scene' in request:
        owner=request['scene']; g=geometry(display,owner)
        if not g: raise RuntimeError('Verifier owner window is absent')
        x=I(); y=I(); child=U()
        X.XTranslateCoordinates(display,owner,root,0,0,C.byref(x),C.byref(y),C.byref(child))
        crop=request.get('sceneCrop',dict(x=0,y=0,width=g['width'],height=g['height']))
        if not all(isinstance(crop.get(k),int) for k in ('x','y','width','height')) or min(crop['x'],crop['y'])<0 or min(crop['width'],crop['height'])<1 or crop['x']+crop['width']>g['width'] or crop['y']+crop['height']>g['height']:
            raise RuntimeError('Scene crop is outside the verifier client window')
        result['scene']=image(display,root,x.value+crop['x'],y.value+crop['y'],crop['width'],crop['height'])
        result['ownerTree']=tree(display,owner)
    print(json.dumps(result))
finally: X.XCloseDisplay(display)
