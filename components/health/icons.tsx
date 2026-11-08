'use client';
// The Health page's glyphs: lucide's own shapes (lucide-react 1.70.0, ISC), drawn inline. Generated from
// node_modules/lucide-react/dist/esm/icons/*.mjs. Inline on purpose: importing lucide-react here shared its modules with
// `/`'s first load and made the bundler regroup it (A25). Decorative: always aria-hidden.
import type { JSX, SVGProps } from 'react';

type Node = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  strokeWidth?: number;
}

export type Icon = (props: IconProps) => JSX.Element;

function make(node: Node): Icon {
  return function GlyphIcon({ size = 16, strokeWidth = 2, ...rest }: IconProps) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...rest}>
        {node.map(([tag, attrs], i) => {
          const Tag = tag as 'path';
          return <Tag key={i} {...attrs} />;
        })}
      </svg>
    );
  };
}

export const Monitor = make([["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"21","y2":"21"}],["line",{"x1":"12","x2":"12","y1":"17","y2":"21"}]]);
export const RefreshCw = make([["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]]);
export const Ellipsis = make([["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]]);
export const Bell = make([["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]]);
export const CircleDot = make([["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"12","r":"10"}]]);
export const MonitorSmartphone = make([["path",{"d":"M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"}],["path",{"d":"M10 19v-3.96 3.15"}],["path",{"d":"M7 19h5"}],["rect",{"width":"6","height":"10","x":"16","y":"12","rx":"2"}]]);
export const Smartphone = make([["rect",{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"}],["path",{"d":"M12 18h.01"}]]);
export const SquareCheck = make([["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]]);
export const Ban = make([["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M4.929 4.929 19.07 19.071"}]]);
export const CloudOff = make([["path",{"d":"M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057"}],["path",{"d":"M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78"}],["path",{"d":"m2 2 20 20"}]]);
export const Hourglass = make([["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]]);
export const MoveVertical = make([["path",{"d":"M12 2v20"}],["path",{"d":"m8 18 4 4 4-4"}],["path",{"d":"m8 6 4-4 4 4"}]]);
export const Repeat = make([["path",{"d":"m17 2 4 4-4 4"}],["path",{"d":"M3 11v-1a4 4 0 0 1 4-4h14"}],["path",{"d":"m7 22-4-4 4-4"}],["path",{"d":"M21 13v1a4 4 0 0 1-4 4H3"}]]);
export const TriangleAlert = make([["path",{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],["path",{"d":"M12 9v4"}],["path",{"d":"M12 17h.01"}]]);
export const Zap = make([["path",{"d":"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"}]]);
export const ZoomIn = make([["circle",{"cx":"11","cy":"11","r":"8"}],["line",{"x1":"21","x2":"16.65","y1":"21","y2":"16.65"}],["line",{"x1":"11","x2":"11","y1":"8","y2":"14"}],["line",{"x1":"8","x2":"14","y1":"11","y2":"11"}]]);
export const ChevronLeft = make([["path",{"d":"m15 18-6-6 6-6"}]]);
export const ChevronRight = make([["path",{"d":"m9 18 6-6-6-6"}]]);
export const Circle = make([["circle",{"cx":"12","cy":"12","r":"10"}]]);
export const Cloud = make([["path",{"d":"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"}]]);
export const Eye = make([["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]]);
export const Hand = make([["path",{"d":"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"}],["path",{"d":"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"}],["path",{"d":"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"}],["path",{"d":"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"}]]);
export const Keyboard = make([["path",{"d":"M10 8h.01"}],["path",{"d":"M12 12h.01"}],["path",{"d":"M14 8h.01"}],["path",{"d":"M16 12h.01"}],["path",{"d":"M18 8h.01"}],["path",{"d":"M6 8h.01"}],["path",{"d":"M7 16h10"}],["path",{"d":"M8 12h.01"}],["rect",{"width":"20","height":"16","x":"2","y":"4","rx":"2"}]]);
export const Layers = make([["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]]);
export const TextCursorInput = make([["path",{"d":"M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"}],["path",{"d":"M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"}],["path",{"d":"M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"}],["path",{"d":"M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"}],["path",{"d":"M9 6v12"}]]);
export const Wifi = make([["path",{"d":"M12 20h.01"}],["path",{"d":"M2 8.82a15 15 0 0 1 20 0"}],["path",{"d":"M5 12.859a10 10 0 0 1 14 0"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}]]);
export const WifiOff = make([["path",{"d":"M12 20h.01"}],["path",{"d":"M8.5 16.429a5 5 0 0 1 7 0"}],["path",{"d":"M5 12.859a10 10 0 0 1 5.17-2.69"}],["path",{"d":"M19 12.859a10 10 0 0 0-2.007-1.523"}],["path",{"d":"M2 8.82a15 15 0 0 1 4.177-2.643"}],["path",{"d":"M22 8.82a15 15 0 0 0-11.288-3.764"}],["path",{"d":"m2 2 20 20"}]]);
export const X = make([["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]]);
