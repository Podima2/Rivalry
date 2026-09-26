import { useEffect, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

const colors = { paper: '#F4F0E8', ink: '#292722', vermilion: '#E24B35', white: '#FFFEFC', muted: '#706B63' };

type Props = {
  visible: boolean;
  selfHandle: string;
  opponentHandle: string;
  distanceKm: number;
  mode: 'friends' | 'strangers';
  onContinue: () => void;
};

function Badge({ handle, tone }: { handle: string; tone: 'self' | 'opponent' }) {
  return (
    <View style={[styles.badge, tone === 'opponent' && styles.badgeOpponent]}>
      <Text style={[styles.badgeInitial, tone === 'opponent' && styles.badgeInitialOpponent]}>{handle.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/** "It's a match" moment: both runner badges fly in, collide, and a burst rings out. */
export default function MatchCelebration({ visible, selfHandle, opponentHandle, distanceKm, mode, onContinue }: Props) {
  const slide = useState(() => new Animated.Value(0))[0];
  const burst = useState(() => new Animated.Value(0))[0];
  const title = useState(() => new Animated.Value(0))[0];
  const pulse = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    if (!visible) return;
    slide.setValue(0); burst.setValue(0); title.setValue(0); pulse.setValue(0);
    const animation = Animated.sequence([
      Animated.spring(slide, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true }),
      Animated.parallel([
        Animated.timing(burst, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(title, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
      ]),
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])),
    ]);
    animation.start();
    return () => animation.stop();
  }, [burst, pulse, slide, title, visible]);

  const leftX = slide.interpolate({ inputRange: [0, 1], outputRange: [-260, -34] });
  const rightX = slide.interpolate({ inputRange: [0, 1], outputRange: [260, 34] });
  const tilt = slide.interpolate({ inputRange: [0, 1], outputRange: ['-25deg', '-8deg'] });
  const tiltRight = slide.interpolate({ inputRange: [0, 1], outputRange: ['25deg', '8deg'] });
  const ringScale = burst.interpolate({ inputRange: [0, 1], outputRange: [0.2, 2.6] });
  const ringOpacity = burst.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.8, 0] });
  const titleScale = title.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const badgeScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        <View style={styles.stage}>
          <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
          <Animated.View style={[styles.ring, styles.ringInner, { opacity: ringOpacity, transform: [{ scale: Animated.multiply(ringScale, 0.6) }] }]} />
          <Animated.View style={{ position: 'absolute', transform: [{ translateX: leftX }, { rotate: tilt }, { scale: badgeScale }] }}>
            <Badge handle={selfHandle} tone="self" />
          </Animated.View>
          <Animated.View style={{ position: 'absolute', transform: [{ translateX: rightX }, { rotate: tiltRight }, { scale: badgeScale }] }}>
            <Badge handle={opponentHandle} tone="opponent" />
          </Animated.View>
        </View>
        <Animated.View style={{ alignItems: 'center', opacity: title, transform: [{ scale: titleScale }] }}>
          <Text style={styles.kicker}>{mode === 'strangers' ? 'RUNNER FOUND' : 'YOUR FRIEND IS IN'}</Text>
          <Text style={styles.title}>It’s a match.</Text>
          <Text style={styles.subtitle}>You’re racing @{opponentHandle} over {distanceKm} km.</Text>
        </Animated.View>
        <Pressable accessibilityRole="button" onPress={onContinue} style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}>
          <Text style={styles.buttonText}>{mode === 'strangers' ? 'Let’s verify and go' : 'Let’s pick routes'}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const BADGE = 112;
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(41,39,34,0.94)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  stage: { width: '100%', height: 220, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  ring: { position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 6, borderColor: colors.vermilion },
  ringInner: { borderColor: colors.white, borderWidth: 3 },
  badge: { width: BADGE, height: BADGE, borderRadius: BADGE / 2, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', borderWidth: 5, borderColor: colors.white },
  badgeOpponent: { backgroundColor: colors.paper, borderColor: colors.vermilion },
  badgeInitial: { color: colors.white, fontFamily: 'serif', fontSize: 50, fontWeight: '700' },
  badgeInitialOpponent: { color: colors.ink },
  kicker: { color: colors.vermilion, fontSize: 11, fontWeight: '900', letterSpacing: 2.2 },
  title: { color: colors.white, fontFamily: 'serif', fontSize: 46, lineHeight: 52, marginTop: 8 },
  subtitle: { color: '#D9D2C6', fontSize: 15, lineHeight: 22, marginTop: 8, textAlign: 'center' },
  button: { marginTop: 34, minHeight: 54, alignSelf: 'stretch', backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
});
