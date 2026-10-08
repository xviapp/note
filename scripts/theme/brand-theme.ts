export type ThemeMode = 'system' | 'light' | 'dark' | 'oled';

export const inkPalette = {
  canvas: '#ffffff', surface: '#ffffff', surfaceRaised: '#ffffff', surfaceSoft: '#ffffff',
  text: '#000000', textMuted: '#333333', border: '#777777', controlBorder: '#000000',
  overlay: 'rgba(255, 255, 255, 0.85)',
};

export interface Palette {
  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceSoft: string;
  surfaceMuted: string;
  border: string;
  controlBorder: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  brand: string;
  brandPressed: string;
  primary: string;
  primarySoft: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  focus: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  nav: string;
  overlay: string;
}

export type BrandTheme = 'moment' | 'video' | 'reader' | 'chase';

type BrandColors = Pick<Palette, 'primary' | 'brandPressed' | 'primarySoft' | 'accent' | 'onAccent'>;
const lightBrands: Record<BrandTheme, BrandColors> = {
  moment: { primary: '#A94F24', brandPressed: '#873C1B', primarySoft: '#F9E8D7', accent: '#36566B', onAccent: '#FFF8EF' },
  video: { primary: '#304F65', brandPressed: '#243E50', primarySoft: '#DEE7EC', accent: '#ED893E', onAccent: '#352317' },
  reader: { primary: '#895332', brandPressed: '#6D4026', primarySoft: '#EFDFC9', accent: '#D8803B', onAccent: '#302015' },
  chase: { primary: '#A8491F', brandPressed: '#873B19', primarySoft: '#F5E4D5', accent: '#EC8948', onAccent: '#302015' },
};
const darkBrands: Record<BrandTheme, BrandColors> = {
  moment: { primary: '#F0AA73', brandPressed: '#D98D56', primarySoft: '#3A2C23', accent: '#9CBED3', onAccent: '#172630' },
  video: { primary: '#A6C5DA', brandPressed: '#85ABC4', primarySoft: '#263D4D', accent: '#F2A15E', onAccent: '#302015' },
  reader: { primary: '#DDB68B', brandPressed: '#C89C70', primarySoft: '#3C2C20', accent: '#E9A46E', onAccent: '#302015' },
  chase: { primary: '#EBA16B', brandPressed: '#D88D58', primarySoft: '#35291F', accent: '#DE995D', onAccent: '#241A13' },
};

/** Shared visual rules; the app selects its identity in its local tokens adapter. */
export function createBrandPalettes(brand: BrandTheme): { lightPalette: Palette; darkPalette: Palette; oledPalette: Palette } {
  const light = lightBrands[brand];
  const dark = darkBrands[brand];
  const blueNight = brand === 'moment' || brand === 'video';
  const lightPalette: Palette = {
    canvas: '#F9EFE2', surface: '#FFF8EF', surfaceRaised: '#FFFCF7',
    surfaceMuted: '#F0E1CF', surfaceSoft: '#F0E1CF',
    text: '#352E28', textMuted: '#706357', textSubtle: '#726151',
    border: '#DDCCB7', controlBorder: '#887461',
    ...light, brand: light.primary, onPrimary: '#FFF8EF',
    focus: '#365F7B', success: '#37654B', warning: '#825519', danger: '#A43E42', info: '#365F7B',
    nav: '#FFF8EF', overlay: 'rgba(40, 32, 25, 0.48)',
  };
  const darkPalette: Palette = {
    canvas: blueNight ? '#131C23' : '#211B17',
    surface: blueNight ? '#1E2B35' : '#2C241E',
    surfaceRaised: blueNight ? '#283743' : '#382E26',
    surfaceMuted: blueNight ? '#2C3C49' : '#403329',
    surfaceSoft: blueNight ? '#2C3C49' : '#403329',
    text: '#F8EFE3', textMuted: '#C5B9AB', textSubtle: '#B9AA9A',
    border: blueNight ? '#405260' : '#554538', controlBorder: '#998876',
    ...dark, brand: dark.primary, onPrimary: '#241C16',
    focus: '#A6C5DA', success: '#91C4A0', warning: '#E6BB75', danger: '#F09A96', info: '#A6C5DA',
    nav: blueNight ? '#17222B' : '#261F1A', overlay: 'rgba(0, 0, 0, 0.72)',
  };
  // Chase's paper surfaces stay neutral at night; orange belongs to actions and the sun.
  if (brand === 'chase') {
    Object.assign(lightPalette, {
      canvas: '#F8F2E8', surface: '#FFFBF4', surfaceRaised: '#FFFFFF',
      surfaceMuted: '#EFE5D6', surfaceSoft: '#EFE5D6',
      border: '#DED1C0', controlBorder: '#8B7968',
      text: '#302B26', textMuted: '#6D6257', textSubtle: '#6D6257',
      onPrimary: '#FFFFFF', nav: '#F8F2E8',
    });
    Object.assign(darkPalette, {
      canvas: '#191817', surface: '#242220', surfaceRaised: '#302D29',
      surfaceMuted: '#211F1D', surfaceSoft: '#211F1D',
      border: '#47413A', controlBorder: '#8E8274',
      text: '#EEE7DD', textMuted: '#B9AFA2', textSubtle: '#B9AFA2',
      onPrimary: '#241A13', nav: '#191817',
    });
  }
  const oledPalette: Palette = {
    ...darkPalette, canvas: '#000000', nav: '#000000',
    surface: blueNight ? '#0C1319' : '#120F0C',
    surfaceRaised: blueNight ? '#17222B' : '#211B16',
    surfaceMuted: blueNight ? '#202E39' : '#30261F',
    surfaceSoft: blueNight ? '#202E39' : '#30261F',
    overlay: 'rgba(0, 0, 0, 0.82)',
  };
  if (brand === 'chase') {
    Object.assign(oledPalette, {
      surface: '#111110', surfaceRaised: '#1C1A18',
      surfaceMuted: '#090909', surfaceSoft: '#090909',
      border: '#38332E', controlBorder: '#817569',
      text: '#E5DED4', textMuted: '#ADA499', textSubtle: '#ADA499',
      brand: '#DB9562', primary: '#DB9562', brandPressed: '#C6804F',
      primarySoft: '#291F18', onPrimary: '#21170F', accent: '#CF8C56',
    });
  }
  return { lightPalette, darkPalette, oledPalette };
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  control: 10,
  card: 12,
  sheet: 20,
  pill: 9999,
} as const;

export const typography = {
  pageTitle: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  section: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 22 },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 18 },
  metric: { fontSize: 24, lineHeight: 32, fontWeight: '700', fontFamily: 'monospace' },
} as const;

export const interaction = { pressedOpacity: 0.66, disabledOpacity: 0.4 } as const;
export const appHeaderHeight = 68;
export const minimumTouchTarget = 48;
export const bottomNavigationItemHeight = 56;

/** Optical sizes for navigation, actions and feature entries. */
export const iconography = { stroke: 1.8, navigation: 22, action: 20, feature: 22 } as const;
