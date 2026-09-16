/** GPU grading and spatial effects shared by thumbnails, preview and export. */
import { canvasOfSize, sizeCanvas } from './frame-source';
import { VideoEffectDefinition } from './video-effects';

const VERTEX = `attribute vec2 position; varying vec2 uv;
void main(){ uv=(position+1.0)*0.5; gl_Position=vec4(position,0.0,1.0); }`;
const FRAGMENT = `precision highp float;
varying vec2 uv;
uniform sampler2D picture;
uniform vec2 resolution;
uniform vec4 grade;
uniform vec4 optics;
uniform float splitAmount, mode, time;
uniform float maskPass, intensity;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec3 read(vec2 p){return texture2D(picture,clamp(p,vec2(0.001),vec2(0.999))).rgb;}
void main(){
  vec2 p=vec2(uv.x,1.0-uv.y);
  float beat=floor(time*7.0);
  float burst=step(0.78,hash(vec2(beat,2.0)));
  if(mode==1.0){p.x+=sin(p.y*28.0+time*3.0)*0.0009;
    p.x+=exp(-pow((p.y-fract(time*0.13))*75.0,2.0))*0.008;}
  if(mode==2.0){p.x+=(hash(vec2(floor(p.y*19.0),beat))-0.5)*0.09*burst;}
  float split=splitAmount*(mode==2.0 ? burst : 1.0);
  if(maskPass==1.0){
    // The coverage of the person in the picture that is actually shown.
    // The displayed frame is mix(original, processed, intensity), so the
    // silhouette that hides the caption is the same mix of the undisplaced
    // and displaced silhouettes. Channel split is unioned across the three
    // sample points: wherever any channel of the person lands, the text
    // behind it must stay covered.
    vec2 base=vec2(uv.x,1.0-uv.y);
    float still=read(base).r;
    float moved=max(read(p+vec2(split,0)).r,max(read(p).r,read(p-vec2(split,0)).r));
    float a=clamp(mix(still,moved,intensity),0.0,1.0);
    gl_FragColor=vec4(a,a,a,a);
    return;
  }
  vec3 c=vec3(read(p+vec2(split,0)).r,read(p).g,read(p-vec2(split,0)).b);
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  c=mix(vec3(l),c,grade.y);
  c=(c-0.5)*grade.x+0.5;
  // Gentle split-toning keeps midtones, especially skin, largely untouched.
  float shadow=1.0-smoothstep(0.05,0.65,l);
  float highlight=smoothstep(0.45,1.0,l);
  c+=grade.z*vec3(1.0,0.24,-0.8)*(0.35+highlight*0.65);
  c+=vec3(-0.012,0.008,0.012)*shadow*max(grade.x-1.0,0.0)*5.0;
  c=mix(c,vec3(0.15,0.13,0.12),grade.w*(1.0-l)*4.0);
  if(mode==3.0){c+=vec3(0.09,-0.035,0.14)*shadow+vec3(-0.045,0.10,0.12)*highlight;}
  if(optics.x>0.0){
    vec3 glow=vec3(0.0);
    for(int x=-2;x<=2;x++)for(int y=-2;y<=2;y++){
      vec3 s=read(p+vec2(float(x),float(y))*0.004);
      glow+=max(s-0.56,0.0)/25.0;
    }
    c+=glow*optics.x*2.0;
  }
  c+=(hash(floor(p*vec2(1280.0,720.0))+floor(time*24.0))-0.5)*optics.y;
  float edge=smoothstep(0.2,0.72,length((p-0.5)*vec2(1.0,0.85)));
  c*=1.0-edge*optics.z;
  if(mode==1.0){c*=1.0-0.055*(0.5+0.5*sin(p.y*720.0*3.14159));}
  if(mode==4.0){vec2 center=vec2(-0.12+0.12*sin(time*0.35),0.3+0.16*cos(time*0.2));
    float leak=exp(-length((p-center)*vec2(1.8,0.8))*4.5);
    c=1.0-(1.0-c)*(1.0-vec3(1.0,0.34,0.10)*leak*0.7);}
  gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
}`;

export class VideoEffectShader {
  private canvas = canvasOfSize(1, 1);
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private buffer: WebGLBuffer | null = null;
  error = '';

  constructor() {
    try {
      const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
      if (!gl) throw new Error('WebGL is unavailable.');
      this.gl = gl;
      const compile = (type: number, code: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, code); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error ?? 'Shader compilation failed.');
        }
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
      this.program = gl.createProgram()!;
      gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Effect shader could not link.');
      gl.useProgram(this.program);
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, 'position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch (error) { this.error = String(error); this.dispose(); }
  }

  render(source: OffscreenCanvas | HTMLCanvasElement, effect: VideoEffectDefinition, time: number): OffscreenCanvas | HTMLCanvasElement | null {
    return this.pass(source, effect, time, 0, 1);
  }

  /**
   * The same geometry, applied to a silhouette instead of a picture.
   *
   * Glitch, VHS and RGB Split move pixels. Cutting the displaced person out
   * with an undisplaced matte leaves the caption showing through one edge of
   * the subject and clips the other, so the matte is sent through this shader
   * with identical `time`, `mode` and `split` and blended by the same intensity
   * the picture was blended with.
   */
  renderMask(source: OffscreenCanvas | HTMLCanvasElement, effect: VideoEffectDefinition,
    time: number, intensity: number): OffscreenCanvas | HTMLCanvasElement | null {
    return this.pass(source, effect, time, 1, Math.max(0, Math.min(1, intensity)));
  }

  private pass(source: OffscreenCanvas | HTMLCanvasElement, effect: VideoEffectDefinition,
    time: number, maskPass: number, intensity: number): OffscreenCanvas | HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program || gl.isContextLost()) { this.error ||= 'Video effect GPU is unavailable.'; return null; }
    sizeCanvas(this.canvas, source.width, source.height);
    gl.viewport(0, 0, source.width, source.height);
    const location = (name: string) => gl.getUniformLocation(this.program!, name);
    gl.uniform4fv(location('grade'), [...(effect.grade ?? [1, 1, 0, 0])]);
    gl.uniform4f(location('optics'), effect.bloom ?? 0, effect.grain ?? 0, effect.vignette ?? 0, 0);
    gl.uniform1f(location('splitAmount'), effect.split ?? 0);
    gl.uniform1f(location('mode'), effect.mode ?? 0);
    gl.uniform1f(location('time'), time);
    gl.uniform1f(location('maskPass'), maskPass);
    gl.uniform1f(location('intensity'), intensity);
    gl.uniform2f(location('resolution'), source.width, source.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
  dispose(): void {
    if (this.gl) {
      this.gl.deleteTexture(this.texture); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null; this.canvas.width = this.canvas.height = 1;
  }
}
