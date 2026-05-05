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
    return { type: "Dense Woody Ambery", description: "Heavy molecular weight (Oud, Benzoin) requiring body heat to achieve optimal sillage.", color: "#78350f", viscosity: 0.002 };
  }
  return { type: "Balanced Iso-E Super", description: "Versatile, transparent composition adapting seamlessly to temperate climates.", color: "#a78bfa", viscosity: 0.008 };
};

const AtmosphericViscosity: React.FC<{ profile: ScentProfile }> = ({ profile }) => {
  const outerMeshRef = useRef<THREE.Mesh>(null);
  const innerMeshRef = useRef<THREE.Mesh>(null);
  const targetColor = useMemo(() => new THREE.Color(profile.color), [profile.color]);

  useFrame(() => {
    if (outerMeshRef.current && innerMeshRef.current) {
      // Outer shell rotation
      outerMeshRef.current.rotation.x += profile.viscosity;
      outerMeshRef.current.rotation.y += profile.viscosity * 1.5;
      
      // Inner core counter-rotation for depth
      innerMeshRef.current.rotation.x -= profile.viscosity * 0.8;
      innerMeshRef.current.rotation.y -= profile.viscosity * 1.2;

      const outerMaterial = outerMeshRef.current.material as THREE.MeshStandardMaterial;
      const innerMaterial = innerMeshRef.current.material as THREE.MeshStandardMaterial;
      
      outerMaterial.color.lerp(targetColor, 0.05);
      innerMaterial.color.lerp(targetColor, 0.05);
    }
  });

  return (
    <group>
      {/* Outer Wireframe Shell */}
      <mesh ref={outerMeshRef} scale={2.8}>
        <icosahedronGeometry args={[1, 2]} />
        <meshStandardMaterial 
          roughness={0.1} 
          metalness={0.9} 
          wireframe={true} 
          transparent={true} 
          opacity={0.25} 
        />
      </mesh>
      {/* Inner Translucent Core */}
      <mesh ref={innerMeshRef} scale={1.9}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial 
          roughness={0.4} 
          metalness={0.7} 
          transparent={true} 
          opacity={0.15} 
        />
      </mesh>
    </group>
  );
};

export const WeatherWidget: React.FC<WeatherWidgetProps> = ({ weather: propWeather, loading: propLoading }) => {
  const [internalWeather, setInternalWeather] = useState<WeatherData | null>(null);
  const [internalLoading, setInternalLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const weather = propWeather !== undefined ? propWeather : internalWeather;
  const loading = propLoading !== undefined ? propLoading : internalLoading;

  useEffect(() => {
    if (propWeather !== undefined) return;
    let isMounted = true;
    
    async function fetchWeather(lat?: number, lon?: number) {
      try {
        const url = lat && lon ? `/api/weather?lat=${lat}&lon=${lon}` : '/api/weather';
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

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    containerRef.current.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
    containerRef.current.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
  };

  if (loading) {
    return (
      <div className="h-full min-h-[400px] w-full bg-neutral-950 flex flex-col items-center justify-center border border-white/10 rounded-3xl p-12 shadow-2xl">
        <div className="relative flex items-center justify-center mb-8">
          <div className="absolute inset-0 border-t-2 border-white/20 rounded-full animate-[spin_3s_linear_infinite]" />
          <div className="w-12 h-12 border-t-2 border-white/60 rounded-full animate-spin" />
        </div>
        <span className="font-serif italic text-white/50 text-[clamp(1rem,2vw,1.25rem)] tracking-wide">Synchronizing telemetry...</span>
      </div>
    );
  }

  const activeWeather = weather || { temp: 72, humidity: 50, condition: "Unknown", isLive: false };
  const scentProfile = getScentProfile(activeWeather.temp, activeWeather.condition);

  return (
    <motion.div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="relative w-full rounded-3xl overflow-hidden bg-neutral-950/60 group border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
      style={{ '--mouse-x': '50%', '--mouse-y': '50%' } as React.CSSProperties}
    >
      {/* Interactive Hover Gradient */}
      <div
        className="absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"
        style={{ background: 'radial-gradient(800px circle at var(--mouse-x) var(--mouse-y), rgba(255,255,255,0.06), transparent 40%)' }}
      />
      
      {/* 3D Atmospheric Canvas */}
      <div className="absolute inset-0 z-0 opacity-30 mix-blend-screen pointer-events-none transition-opacity duration-1000 group-hover:opacity-40">
        <Canvas camera={{ position: [0, 0, 5.5] }}>
          <ambientLight intensity={0.4} />
          <directionalLight position={[10, 10, 5]} intensity={1.5} />
          <pointLight position={[-10, -10, -5]} intensity={0.5} color={scentProfile.color} />
          <AtmosphericViscosity profile={scentProfile} />
        </Canvas>
      </div>

      {/* Main Content Layer */}
      <div className="relative z-20 w-full p-8 md:p-10 flex flex-col lg:flex-row gap-8 lg:gap-14 items-center">
        
        {/* Telemetry Block */}
        <div className="flex flex-col sm:flex-row items-center gap-8 lg:gap-12 w-full lg:w-auto">
          <div className="flex items-center gap-6">
            <div className="flex items-start gap-1">
              <span className="text-[clamp(3rem,6vw,4.5rem)] font-serif italic text-white tracking-tighter leading-none drop-shadow-md">
                {Math.round(activeWeather.temp)}
              </span>
              <span className="text-xl font-serif text-white/40 tracking-widest leading-none mt-2">°F</span>
            </div>
            
            <div className="space-y-2 pl-6 border-l border-white/10">
              <div className="flex items-center gap-3 text-[11px] text-white/50 uppercase tracking-[0.25em] font-mono">
                <Droplets size={14} className="text-white/30" />
                <span className="text-white/90 font-medium">{activeWeather.humidity}%</span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-white/50 uppercase tracking-[0.25em] font-mono">
                <Cloud size={14} className="text-white/30" />
                <span className="text-white/90 font-medium truncate max-w-[120px]">{activeWeather.condition}</span>
              </div>
            </div>
          </div>

          <div className="h-10 w-[1px] bg-white/10 hidden sm:block" />
          
          <div className="space-y-1.5 flex flex-col items-center sm:items-start">
            <div className="flex items-center gap-3">
              <p className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-mono font-medium whitespace-nowrap">
                {activeWeather.isLive ? activeWeather.location : 'Sandbox Node'}
              </p>
              {activeWeather.isLive && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                </span>
              )}
            </div>
            <h2 className="font-serif italic text-sm text-white/60 tracking-tight uppercase">Atmospheric Insights</h2>
          </div>
        </div>

        {/* Scent Guidance Block */}
        <div className="flex-1 w-full lg:pl-14 lg:border-l border-white/10 py-4 lg:py-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 mb-3">
            <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 font-mono whitespace-nowrap font-medium">
              Guidance
            </p>
            <div className="h-[1px] flex-1 bg-white/10 hidden sm:block" />
            <h3 
              className="text-lg font-serif italic tracking-wide drop-shadow-sm transition-colors duration-700" 
              style={{ color: scentProfile.color }}
            >
              {scentProfile.type}
            </h3>
          </div>
          <p className="text-[13px] font-sans text-white/60 leading-relaxed max-w-2xl font-light">
            {scentProfile.description}
          </p>
        </div>

      </div>
    </motion.div>
  );
};