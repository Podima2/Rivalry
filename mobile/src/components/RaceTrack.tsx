import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

const colors = { paper: '#F4F0E8', paperDeep: '#E9E2D7', ink: '#292722', muted: '#706B63', vermilion: '#E24B35', line: '#C9C0B3', white: '#FFFEFC', green: '#4E6A54' };

export type TrackRunner = {
  handle: string;
  isSelf: boolean;
  state: 'running' | 'finished' | 'dnf';
  progressMeters: number;
  routeDistanceMeters: number;
  elapsedMs: number | null;
};

type Props = {
  runners: TrackRunner[];
  distanceKm: number;
  /** Server start time and the phone's offset to server time, for a clock that survives GPS loss. */
  startedAt: string | null;
  serverOffsetMs: number;
  live: boolean;
};

const TOKEN = 30;

function formatClock(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const seconds = (total % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function formatGap(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function Lane({ runner, width, distanceKm }: { runner: TrackRunner; width: number; distanceKm: number }) {
  const fraction = Math.min(1, runner.progressMeters / Math.max(1, runner.routeDistanceMeters));
  const [position] = useState(() => new Animated.Value(0));
  const travel = Math.max(0, width - TOKEN);

  useEffect(() => {
    Animated.timing(position, { toValue: fraction * travel, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [fraction, position, travel]);

  // Split markers every kilometre (every 250 m on the 1 km race).
  const splitMeters = distanceKm === 1 ? 250 : 1000;
  const splits = Math.max(0, Math.round((distanceKm * 1000) / splitMeters) - 1);
  const tone = runner.isSelf ? colors.vermilion : colors.ink;

  return (
    <View style={styles.lane}>
      <View style={styles.laneHeader}>
        <Text style={[styles.laneName, { color: tone }]}>{runner.isSelf ? 'YOU' : `@${runner.handle.toUpperCase()}`}</Text>
        <Text style={styles.laneValue}>{runner.state === 'dnf' ? 'DNF'
          : runner.state === 'finished' ? `FINISHED · ${formatClock(runner.elapsedMs ?? 0)}`
            : `${(runner.progressMeters / 1000).toFixed(2)} / ${(runner.routeDistanceMeters / 1000).toFixed(2)} KM`}</Text>
      </View>
      <View style={styles.track}>
        <Animated.View style={[styles.trail, { width: Animated.add(position, TOKEN / 2), backgroundColor: tone }]} />
        {Array.from({ length: splits }, (_, index) => (
          <View key={index} style={[styles.split, { left: TOKEN / 2 + ((index + 1) / (splits + 1)) * travel }]} />
        ))}
        <View style={styles.finish}>
          {Array.from({ length: 8 }, (_, index) => (
            <View key={index} style={[styles.check, (index + Math.floor(index / 2)) % 2 === 0 && styles.checkDark]} />
          ))}
        </View>
        <Animated.View style={[styles.token, { backgroundColor: tone, transform: [{ translateX: position }] }, runner.state === 'dnf' && styles.tokenOut]}>
          <Text style={styles.tokenText}>{runner.state === 'finished' ? '✓' : runner.handle.slice(0, 1).toUpperCase()}</Text>
        </Animated.View>
      </View>
      <View style={styles.splitLabels}>
        <Text style={styles.splitLabel}>START</Text>
        <Text style={styles.splitLabel}>{runner.state === 'running' ? `${formatGap(Math.max(0, runner.routeDistanceMeters - runner.progressMeters))} TO GO` : ''}</Text>
        <Text style={styles.splitLabel}>{distanceKm} KM</Text>
      </View>
    </View>
  );
}

/** Head-to-head race track: live clock, lead gap, pace, and a lane per runner. */
export default function RaceTrack({ runners, distanceKm, startedAt, serverOffsetMs, live }: Props) {
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const self = runners.find((runner) => runner.isSelf);
  const rival = runners.find((runner) => !runner.isSelf);
  const elapsed = startedAt ? now + serverOffsetMs - Date.parse(startedAt) : 0;
  const clock = self?.state === 'finished' && self.elapsedMs !== null ? self.elapsedMs : elapsed;
  const paceSecondsPerKm = self && self.progressMeters >= 50 && elapsed > 0 ? (elapsed / 1000) / (self.progressMeters / 1000) : null;
  const gap = self && rival ? self.progressMeters - rival.progressMeters : 0;
  const lead = !self || !rival || rival.state === 'dnf' || self.state === 'dnf' ? null
    : Math.abs(gap) < 10 ? { text: 'NECK AND NECK', tone: colors.ink }
      : gap > 0 ? { text: `YOU LEAD BY ${formatGap(gap)}`, tone: colors.green }
        : { text: `@${rival.handle.toUpperCase()} LEADS BY ${formatGap(-gap)}`, tone: colors.vermilion };

  return (
    <View style={styles.card} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width - 32)}>
      <View style={styles.clockRow}>
        <View>
          <Text style={styles.metricLabel}>RACE CLOCK</Text>
          <Text style={styles.clock}>{formatClock(clock)}</Text>
        </View>
        <View style={styles.paceBox}>
          <Text style={styles.metricLabel}>YOUR PACE</Text>
          <Text style={styles.pace}>{paceSecondsPerKm ? `${Math.floor(paceSecondsPerKm / 60)}:${Math.round(paceSecondsPerKm % 60).toString().padStart(2, '0')}` : '—'}<Text style={styles.paceUnit}> /KM</Text></Text>
        </View>
      </View>
      {lead ? <Text style={[styles.lead, { color: lead.tone, borderColor: lead.tone }]}>{lead.text}</Text> : null}
      {width > 0 ? [self, rival].filter((runner): runner is TrackRunner => Boolean(runner)).map((runner) => (
        <Lane key={runner.handle} runner={runner} width={width} distanceKm={distanceKm} />
      )) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 16 },
  clockRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  metricLabel: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  clock: { color: colors.ink, fontFamily: 'serif', fontSize: 46, lineHeight: 52, fontVariant: ['tabular-nums'] },
  paceBox: { alignItems: 'flex-end' },
  pace: { color: colors.ink, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  paceUnit: { color: colors.muted, fontSize: 10, fontWeight: '800' },
  lead: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '900', letterSpacing: 1.3, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5, marginTop: 10, marginBottom: 4 },
  lane: { marginTop: 14 },
  laneHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  laneName: { fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  laneValue: { color: colors.ink, fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: TOKEN, justifyContent: 'center', backgroundColor: colors.paperDeep, borderRadius: TOKEN / 2 },
  trail: { position: 'absolute', left: 0, top: TOKEN / 2 - 2, height: 4, borderRadius: 2, opacity: 0.85 },
  split: { position: 'absolute', top: 7, width: 2, height: TOKEN - 14, backgroundColor: colors.line },
  finish: { position: 'absolute', right: 6, top: 7, width: 8, height: TOKEN - 14, flexDirection: 'row', flexWrap: 'wrap' },
  check: { width: 4, height: (TOKEN - 14) / 4, backgroundColor: colors.white },
  checkDark: { backgroundColor: colors.ink },
  token: { position: 'absolute', left: 0, width: TOKEN, height: TOKEN, borderRadius: TOKEN / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.white },
  tokenOut: { opacity: 0.35 },
  tokenText: { color: colors.white, fontSize: 13, fontWeight: '900' },
  splitLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  splitLabel: { color: colors.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.9 },
});
