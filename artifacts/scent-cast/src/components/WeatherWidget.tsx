import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Cloud, Droplets } from 'lucide-react';
import { motion } from 'framer-motion';
import axios from 'axios';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';

interface WeatherData {
  temp: number;
  humidity: number;
  condition: string;
  icon?: string;
  location?: string;
  isLive?: boolean;
  error?: string;
}

interface ScentProfile {
  type: string;
  description: string;
  color: string;
  viscosity: number;
}

interface WeatherWidgetProps {
  weather?: WeatherData | null;
  loading?: boolean;
}

const getScentProfile = (temp: number, condition: string): ScentProfile => {
  const conditionLower = condition.toLowerCase();
  if (conditionLower.includes('rain') || conditionLower.includes('mist')) {
    return { type: "Aquatic & Petrichor", description: "Ozone, damp earth, and crushed violet leaf to harmonize with atmospheric moisture.", color: "#64748b", viscosity: 0.005 };
  }
  if (temp > 82) {
    return { type: "High-Velocity Citrus", description: "Volatile, sharp molecules (Bergamot, Yuzu) engineered to project without overwhelming heat.", color: "#fbbf24", viscosity: 0.02 };
  }
  if (temp < 60) {
    return { type: "Dense Woody Ambery", description: "Heavy molecular weight (Oud, Benzoin) requiring body heat to achieve optimal sillage.", color: "#c98b2c", viscosity: 0.002 };
  }
  return { type: "Balanced Iso-E Super", description: "Versatile, transparent composition adapting seamlessly to temperate climates.", color: "#a78bfa", viscosity: 0.008 };
};

const AtmosphericViscosity: React.FC<{ profile: ScentProfile }> = ({ profile }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const targetColor = useMemo(() => new THREE.Color(profile.color), [profile.color]);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.x += profile.viscosity;
      meshRef.current.rotation.y += profile.viscosity * 1.5;
      const material = meshRef.current.material as THREE.MeshStandardMaterial;
      material.color.lerp(targetColor, 0.05);
    }
  });

  return (
    <mesh ref={meshRef} scale={2.5}>
      <icosahedronGeometry args={[1, 2]} />
      <meshStandardMaterial roughness={0.2} metalness={0.8} wireframe={true} transparent={true} opacity={0.3} />
    </mesh>
  );
};

export const WeatherWidget: React.FC<WeatherWidgetProps> = ({ weather: propWeather, loading: propLoading }) => {
  const [internalWeather, setInternalWeather] = useState<WeatherData | null>(null);
  const [internalLoading, setInternalLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingMouseRef = useRef<{ x: number; y: number } | null>(null);

  const weather = propWeather !== undefined ? propWeather : internalWeather;
  const loading = propLoading !== undefined ? propLoading : internalLoading;

  useEffect(() => {
    if (propWeather !== undefined) return;
    let isMounted = true;
    async function fetchWeather(lat?: number, lon?: number) {
      try {
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
        const url = hasCoords ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
        const response = await axios.get(url);
        if (isMounted) setInternalWeather(response.data);
      } catch {
        if (isMounted) setInternalWeather({ temp: 68.4, humidity: 45, condition: "Controlled Environment", location: "Local Sandbox", isLive: false });
      } finally {
        if (isMounted) setInternalLoading(false);
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude),
        () => fetchWeather()
      );
    } else {
      fetchWeather();
    }
    return () => { isMounted = false; };
  }, [propWeather]);

  useEffect(() => {
    return () => {
      if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    pendingMouseRef.current = { x: e.clientX, y: e.clientY };
    if (hoverFrameRef.current !== null) return;

    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      if (!containerRef.current || !pendingMouseRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      containerRef.current.style.setProperty('--mouse-x', `${pendingMouseRef.current.x - rect.left}px`);
      containerRef.current.style.setProperty('--mouse-y', `${pendingMouseRef.current.y - rect.top}px`);
    });
  };

  if (loading) {
    return (
      <div className="h-full min-h-[400px] w-full bg-neutral-950 flex flex-col items-center justify-center border border-white/5 rounded-3xl p-12">
        <div className="w-12 h-12 border-t-2 border-white/40 rounded-full animate-spin mb-6" />
        <span className="font-serif italic text-white/40 text-[clamp(1rem,2vw,1.25rem)] tracking-tight">Synchronizing telemetry...</span>
      </div>
    );
  }

  const activeWeather = weather || { temp: 72, humidity: 50, condition: "Unknown", isLive: false };
  const scentProfile = getScentProfile(activeWeather.temp, activeWeather.condition);

  return (
    <motion.div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="relative w-full rounded-3xl overflow-hidden bg-neutral-950/50 group border border-white/5"
      style={{ '--mouse-x': '50%', '--mouse-y': '50%' } as React.CSSProperties}
    >
      <div
        className="absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{ background: 'radial-gradient(600px circle at var(--mouse-x) var(--mouse-y), rgba(255,255,255,0.08), transparent 40%)' }}
      />
      <div className="absolute inset-0 z-0 opacity-20 mix-blend-screen pointer-events-none">
        <Canvas camera={{ position: [0, 0, 5] }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[10, 10, 5]} intensity={1} />
          <AtmosphericViscosity profile={scentProfile} />
        </Canvas>
      </div>
      <div className="relative z-20 w-full p-6 md:p-8 flex flex-col lg:flex-row gap-6 lg:gap-12 items-center backdrop-blur-xl">
        <div className="flex flex-col sm:flex-row items-center gap-8 lg:gap-12">
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-1">
              <span className="text-[clamp(2.5rem,5vw,3.5rem)] font-serif italic text-white tracking-tighter leading-none">{Math.round(activeWeather.temp)}</span>
              <span className="text-lg font-serif text-white/30 tracking-widest leading-none">°F</span>
            </div>
            <div className="space-y-1 pl-4 border-l border-white/10">
              <div className="flex items-center gap-3 text-[10px] text-white/50 uppercase tracking-[0.2em] font-mono">
                <Droplets size={12} className="text-white/20" />
                <span className="text-white/80">{activeWeather.humidity}%</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-white/50 uppercase tracking-[0.2em] font-mono">
                <Cloud size={12} className="text-white/20" />
                <span className="text-white/80 truncate max-w-[100px]">{activeWeather.condition}</span>
              </div>
            </div>
          </div>
          <div className="h-8 w-[1px] bg-white/5 hidden sm:block" />
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <p className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-mono font-medium whitespace-nowrap">
                {activeWeather.isLive ? activeWeather.location : 'Sandbox Node'}
              </p>
              {activeWeather.isLive && <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />}
            </div>
            <h2 className="font-serif italic text-sm text-white/70 tracking-tight uppercase">Atmospheric Insights</h2>
          </div>
        </div>
        <div className="flex-1 w-full lg:pl-12 lg:border-l border-white/10 py-4 lg:py-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            <p className="text-[9px] uppercase tracking-[0.4em] text-white/30 font-mono whitespace-nowrap">Guidance</p>
            <div className="h-[1px] flex-1 bg-white/5 hidden sm:block" />
            <h3 className="text-base font-serif italic tracking-wide" style={{ color: scentProfile.color }}>{scentProfile.type}</h3>
          </div>
          <p className="text-[12px] font-sans text-white/50 leading-relaxed max-w-2xl mt-1">{scentProfile.description}</p>
        </div>
      </div>
    </motion.div>
  );
};
