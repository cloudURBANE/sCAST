/**
 * Thread line definitions extracted from production bundle (function a6 in index-Z6mn_Ewt3.js).
 * Each thread is a thin gradient div animated via requestAnimationFrame.
 */

export type ThreadLine = {
  id: string;
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  width: string;
  height: string;
  background: string;
  boxShadow?: string;
  filter?: string;
  axis: 'x' | 'y';
  direction: 1 | -1;
  speed: number;
  wrap: number;
  fade: number | null;
  delay: number;
};

export const THREAD_LINES: ThreadLine[] = [
  {
    id: 'dark-1',
    top: '20%', left: '0px', width: '100px', height: '2.5px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.6) 20%, rgba(0, 0, 0, 0.8) 50%, rgba(0, 0, 0, 0.6) 80%, transparent 100%)',
    boxShadow: '0 0 30px rgba(0, 0, 0, 0.5), 0 0 60px rgba(0, 0, 0, 0.3)',
    filter: 'blur(0.3px)',
    axis: 'x', direction: 1, speed: 2.8, wrap: 100, fade: 50, delay: 0,
  },
  {
    id: 'dark-2',
    top: '40%', right: '0px', width: '80px', height: '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.5) 30%, rgba(0, 0, 0, 0.7) 50%, rgba(0, 0, 0, 0.5) 70%, transparent 100%)',
    boxShadow: '0 0 25px rgba(0, 0, 0, 0.4), 0 0 50px rgba(0, 0, 0, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: -1, speed: 2, wrap: 80, fade: 50, delay: 800,
  },
  {
    id: 'gold-1',
    top: '60%', left: '0px', width: '90px', height: '2.5px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(120, 73, 18, 0.8) 25%, rgba(201, 139, 44, 0.9) 50%, rgba(251, 191, 36, 0.8) 75%, transparent 100%)',
    boxShadow: '0 0 30px rgba(201, 139, 44, 0.6), 0 0 60px rgba(251, 191, 36, 0.35)',
    filter: 'blur(0.3px)',
    axis: 'x', direction: 1, speed: 2.1, wrap: 90, fade: 45, delay: 1600,
  },
  {
    id: 'dark-v-1',
    top: '0px', left: '25%', width: '2px', height: '85px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.5) 25%, rgba(0, 0, 0, 0.7) 50%, rgba(0, 0, 0, 0.5) 75%, transparent 100%)',
    boxShadow: '0 0 20px rgba(0, 0, 0, 0.4), 0 0 40px rgba(0, 0, 0, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'y', direction: 1, speed: 1.5, wrap: 85, fade: 40, delay: 400,
  },
  {
    id: 'gold-v-1',
    bottom: '0px', right: '30%', width: '2.5px', height: '75px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(251, 191, 36, 0.7) 20%, rgba(201, 139, 44, 0.82) 50%, rgba(120, 73, 18, 0.7) 80%, transparent 100%)',
    boxShadow: '0 0 25px rgba(251, 191, 36, 0.45), 0 0 50px rgba(201, 139, 44, 0.28)',
    filter: 'blur(0.3px)',
    axis: 'y', direction: -1, speed: 1.9, wrap: 75, fade: 40, delay: 2400,
  },
  {
    id: 'dark-3',
    top: '30%', left: '0px', width: '60px', height: '1.5px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.25) 35%, rgba(0, 0, 0, 0.4) 50%, rgba(0, 0, 0, 0.25) 65%, transparent 100%)',
    boxShadow: '0 0 10px rgba(0, 0, 0, 0.2)',
    axis: 'x', direction: 1, speed: 1, wrap: 60, fade: null, delay: 7000,
  },
  {
    id: 'dark-4',
    top: '80%', left: '0px', width: '95px', height: '1.8px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.4) 35%, rgba(0, 0, 0, 0.6) 50%, rgba(0, 0, 0, 0.4) 65%, transparent 100%)',
    boxShadow: '0 0 15px rgba(0, 0, 0, 0.3), 0 0 30px rgba(0, 0, 0, 0.1)',
    filter: 'blur(0.4px)',
    axis: 'x', direction: 1, speed: 2.2, wrap: 95, fade: null, delay: 1200,
  },
  {
    id: 'white-1',
    top: '25%', left: '0px', width: '75px', height: '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.5) 35%, #FFFFFF 50%, rgba(255, 255, 255, 0.5) 65%, transparent 100%)',
    boxShadow: '0 0 18px rgba(255, 255, 255, 0.4), 0 0 35px rgba(255, 255, 255, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: 1, speed: 1.6, wrap: 75, fade: null, delay: 2000,
  },
  {
    id: 'dark-5',
    top: '50%', left: '0px', width: '50px', height: '1px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.2) 40%, rgba(0, 0, 0, 0.3) 50%, rgba(0, 0, 0, 0.2) 60%, transparent 100%)',
    boxShadow: '0 0 8px rgba(0, 0, 0, 0.15)',
    axis: 'x', direction: 1, speed: 0.6, wrap: 50, fade: null, delay: 12000,
  },
  {
    id: 'dark-v-2',
    bottom: '0px', right: '50%', width: '0.8px', height: '40px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.15) 45%, rgba(0, 0, 0, 0.2) 50%, rgba(0, 0, 0, 0.15) 55%, transparent 100%)',
    boxShadow: '0 0 6px rgba(0, 0, 0, 0.1)',
    axis: 'y', direction: -1, speed: 0.4, wrap: 40, fade: null, delay: 18000,
  },
  {
    id: 'dark-6',
    top: '10%', left: '0px', width: '65px', height: '1.8px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.4) 30%, rgba(0, 0, 0, 0.6) 50%, rgba(0, 0, 0, 0.4) 70%, transparent 100%)',
    boxShadow: '0 0 16px rgba(0, 0, 0, 0.3), 0 0 32px rgba(0, 0, 0, 0.1)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: 1, speed: 2.1, wrap: 65, fade: null, delay: 3200,
  },
  {
    id: 'gold-2',
    top: '70%', left: '0px', width: '55px', height: '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(201, 139, 44, 0.62) 30%, rgba(251, 191, 36, 0.8) 50%, rgba(120, 73, 18, 0.62) 70%, transparent 100%)',
    boxShadow: '0 0 16px rgba(201, 139, 44, 0.4), 0 0 32px rgba(251, 191, 36, 0.22)',
    filter: 'blur(0.3px)',
    axis: 'x', direction: 1, speed: 1.6, wrap: 55, fade: null, delay: 4800,
  },
  {
    id: 'dark-7',
    top: '85%', right: '0px', width: '45px', height: '1px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.2) 35%, rgba(0, 0, 0, 0.3) 50%, rgba(0, 0, 0, 0.2) 65%, transparent 100%)',
    boxShadow: '0 0 8px rgba(0, 0, 0, 0.15)',
    axis: 'x', direction: -1, speed: 0.7, wrap: 45, fade: null, delay: 15000,
  },
  {
    id: 'gold-3',
    top: '50%', left: '0px', width: '70px', height: '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(120, 73, 18, 0.62) 25%, rgba(201, 139, 44, 0.8) 50%, rgba(120, 73, 18, 0.62) 75%, transparent 100%)',
    boxShadow: '0 0 18px rgba(201, 139, 44, 0.4), 0 0 36px rgba(251, 191, 36, 0.18)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: 1, speed: 1.4, wrap: 70, fade: null, delay: 5600,
  },
  {
    id: 'gold-v-2',
    top: '0px', right: '20%', width: '1.8px', height: '60px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(251, 191, 36, 0.52) 25%, rgba(201, 139, 44, 0.72) 50%, rgba(251, 191, 36, 0.52) 75%, transparent 100%)',
    boxShadow: '0 0 15px rgba(251, 191, 36, 0.38), 0 0 30px rgba(201, 139, 44, 0.22)',
    filter: 'blur(0.2px)',
    axis: 'y', direction: 1, speed: 1.2, wrap: 60, fade: null, delay: 6400,
  },
  {
    id: 'white-2',
    top: '35%', left: '0px', width: '75px', height: '2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.7) 25%, rgba(255, 255, 255, 0.9) 50%, rgba(255, 255, 255, 0.7) 75%, transparent 100%)',
    boxShadow: '0 0 20px rgba(255, 255, 255, 0.6), 0 0 40px rgba(255, 255, 255, 0.3)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: 1, speed: 1.8, wrap: 75, fade: 40, delay: 8000,
  },
  {
    id: 'white-v-1',
    top: '0px', left: '45%', width: '1.5px', height: '65px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.6) 25%, rgba(255, 255, 255, 0.8) 50%, rgba(255, 255, 255, 0.6) 75%, transparent 100%)',
    boxShadow: '0 0 18px rgba(255, 255, 255, 0.5), 0 0 36px rgba(255, 255, 255, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'y', direction: 1, speed: 1.5, wrap: 65, fade: 35, delay: 9600,
  },
  {
    id: 'white-3',
    top: '55%', right: '0px', width: '70px', height: '1.8px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.6) 30%, rgba(255, 255, 255, 0.8) 50%, rgba(255, 255, 255, 0.6) 70%, transparent 100%)',
    boxShadow: '0 0 16px rgba(255, 255, 255, 0.5), 0 0 32px rgba(255, 255, 255, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: -1, speed: 1.6, wrap: 70, fade: 40, delay: 11200,
  },
  {
    id: 'white-4',
    top: '90%', left: '0px', width: '80px', height: '2.2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.7) 20%, rgba(255, 255, 255, 0.9) 50%, rgba(255, 255, 255, 0.7) 80%, transparent 100%)',
    boxShadow: '0 0 22px rgba(255, 255, 255, 0.6), 0 0 44px rgba(255, 255, 255, 0.3)',
    filter: 'blur(0.3px)',
    axis: 'x', direction: 1, speed: 1.7, wrap: 80, fade: 45, delay: 12800,
  },
  {
    id: 'white-v-2',
    bottom: '0px', right: '10%', width: '1.6px', height: '60px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.6) 25%, rgba(255, 255, 255, 0.8) 50%, rgba(255, 255, 255, 0.6) 75%, transparent 100%)',
    boxShadow: '0 0 18px rgba(255, 255, 255, 0.5), 0 0 36px rgba(255, 255, 255, 0.2)',
    filter: 'blur(0.2px)',
    axis: 'y', direction: -1, speed: 1.4, wrap: 60, fade: 35, delay: 14400,
  },
  {
    id: 'gold-v-3',
    top: '0px', left: '15%', width: '2px', height: '85px',
    background: 'linear-gradient(180deg, transparent 0%, rgba(251, 191, 36, 0.42) 20%, rgba(201, 139, 44, 0.62) 50%, rgba(120, 73, 18, 0.42) 80%, transparent 100%)',
    boxShadow: '0 0 25px rgba(251, 191, 36, 0.28), 0 0 50px rgba(201, 139, 44, 0.12)',
    filter: 'blur(0.3px)',
    axis: 'y', direction: 1, speed: 0.8, wrap: 85, fade: 45, delay: 7200,
  },
  {
    id: 'gold-4',
    top: '45%', left: '0px', width: '95px', height: '2.2px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(201, 139, 44, 0.52) 25%, rgba(251, 191, 36, 0.72) 50%, rgba(120, 73, 18, 0.52) 75%, transparent 100%)',
    boxShadow: '0 0 28px rgba(201, 139, 44, 0.38), 0 0 56px rgba(251, 191, 36, 0.2)',
    filter: 'blur(0.3px)',
    axis: 'x', direction: 1, speed: 1.1, wrap: 95, fade: 50, delay: 8800,
  },
  {
    id: 'gold-5',
    top: '75%', right: '0px', width: '75px', height: '1.8px',
    background: 'linear-gradient(90deg, transparent 0%, rgba(120, 73, 18, 0.42) 30%, rgba(201, 139, 44, 0.62) 50%, rgba(251, 191, 36, 0.42) 70%, transparent 100%)',
    boxShadow: '0 0 20px rgba(201, 139, 44, 0.3), 0 0 40px rgba(251, 191, 36, 0.12)',
    filter: 'blur(0.2px)',
    axis: 'x', direction: -1, speed: 0.9, wrap: 75, fade: 40, delay: 10400,
  },
];
