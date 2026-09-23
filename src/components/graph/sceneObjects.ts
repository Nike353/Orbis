import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LinearFilter,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import type { GraphNode } from '../../domain/schema';
import {
  TYPE_COLORS,
  type Point3,
  type SceneData,
  type SceneField,
  type SceneNode,
} from './sceneModel';

const STAR_COLORS = ['#d8e4ea', '#5f91aa', '#efc982', '#9b83ba', '#69a993'];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(value: string, salt: number) {
  let state = hashString(value) ^ salt;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  return ((state ^ (state >>> 16)) >>> 0) / 0xffffffff;
}

function splitLabel(label: string, maximum = 31) {
  const words = label.split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const current = lines[lines.length - 1];
    if (current && `${current} ${word}`.length > maximum && lines.length < 2) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = current ? `${current} ${word}` : word;
    }
  }
  if (lines[1]?.length > maximum + 5) {
    lines[1] = `${lines[1].slice(0, maximum + 2)}...`;
  }
  return lines;
}

function createTextSprite(
  lines: string[],
  {
    accent,
    detail,
    width,
    opacity = 1,
    fontSize = 35,
  }: {
    accent: string;
    detail?: string;
    width: number;
    opacity?: number;
    fontSize?: number;
  },
) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = detail ? 228 : 176;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(2, 6, 9, 0.98)';
  context.shadowBlur = 15;
  context.fillStyle = '#f1f6f8';
  context.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  const firstY = lines.length === 1 ? 82 : 59;
  lines.forEach((line, index) => context.fillText(line, 512, firstY + index * 44, 960));
  if (detail) {
    context.shadowBlur = 8;
    context.fillStyle = '#9eafb8';
    context.font = '650 25px Inter, Arial, sans-serif';
    context.fillText(detail, 512, 179, 940);
  }
  context.shadowBlur = 0;
  context.fillStyle = accent;
  context.fillRect(420, canvas.height - 14, 184, 4);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const sprite = new Sprite(
    new SpriteMaterial({
      map: texture,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: false,
    }),
  );
  sprite.scale.set(width, width * (canvas.height / canvas.width), 1);
  sprite.renderOrder = 20;
  return sprite;
}

function orbitRing(
  radius: number,
  color: string,
  opacity: number,
  scale: Point3 = { x: 1, y: 1, z: 1 },
) {
  const points = Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return new Vector3(
      Math.cos(angle) * radius * scale.x,
      Math.sin(angle) * radius * scale.y,
      0,
    );
  });
  return new LineLoop(
    new BufferGeometry().setFromPoints(points),
    new LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function paperObject(node: SceneNode, selected: boolean, hovered: boolean) {
  const group = new Group();
  const emphasized = selected || hovered;
  const radius = node.radius * (emphasized ? 1.12 : 1);
  const dimOpacity = node.dimmed && !hovered ? 0.16 : 1;
  const clusterColor = new Color(node.clusterColor);
  const coreColor = clusterColor.clone().lerp(new Color('#e7eef1'), 0.58);

  const core = new Mesh(
    new IcosahedronGeometry(radius, 3),
    new MeshStandardMaterial({
      color: coreColor,
      emissive: clusterColor.clone().multiplyScalar(emphasized ? 0.52 : 0.3),
      emissiveIntensity: emphasized ? 1.18 : 0.78,
      roughness: 0.3,
      metalness: 0.16,
      transparent: true,
      opacity: 0.96 * dimOpacity,
      depthWrite: !node.dimmed || emphasized,
    }),
  );
  group.add(core);

  const glow = new Mesh(
    new SphereGeometry(radius * 1.75, 20, 14),
    new MeshBasicMaterial({
      color: clusterColor,
      transparent: true,
      opacity: (emphasized ? 0.14 : 0.05) * dimOpacity,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(glow);

  if (emphasized && (node.status === 'proposed' || node.status === 'uncertain')) {
    const status = orbitRing(
      radius * 1.82,
      node.status === 'proposed' ? '#f2a451' : '#bd8ce6',
      0.76 * dimOpacity,
    );
    status.rotation.y = Math.PI * 0.5;
    group.add(status);
  }

  if (emphasized) {
    const focus = orbitRing(radius * 2.02, '#ffffff', selected ? 0.92 : 0.64);
    focus.rotation.x = Math.PI * 0.5;
    group.add(focus);
  }

  if (node.labelVisible || emphasized) {
    const year = node.original.paper?.year;
    const detail = emphasized
      ? `${year ?? ''}${year ? '  |  ' : ''}${node.memberships.length} field${
          node.memberships.length === 1 ? '' : 's'
        }  |  ${node.paperDegree} paper links`
      : undefined;
    const label = createTextSprite(splitLabel(node.label, 32), {
      accent: node.clusterColor,
      detail,
      width: emphasized ? 76 : 58,
      opacity: node.dimmed && !hovered ? 0.22 : emphasized ? 1 : 0.78,
      fontSize: emphasized ? 35 : 31,
    });
    if (label) {
      label.position.set(0, radius + (emphasized ? 12 : 9), 0);
      group.add(label);
    }
  }
  return group;
}

function geometryForConcept(type: GraphNode['type'], radius: number) {
  switch (type) {
    case 'method':
      return new OctahedronGeometry(radius);
    case 'representation':
      return new DodecahedronGeometry(radius);
    case 'assumption':
      return new ConeGeometry(radius, radius * 1.65, 6);
    case 'experiment':
      return new BoxGeometry(radius * 1.55, radius * 1.55, radius * 1.55);
    case 'open_question':
      return new TorusGeometry(radius * 0.82, radius * 0.24, 8, 28);
    default:
      return new SphereGeometry(radius, 18, 12);
  }
}

function conceptObject(node: SceneNode, selected: boolean, hovered: boolean) {
  const group = new Group();
  const emphasized = selected || hovered;
  const opacity = node.dimmed && !hovered ? 0.1 : emphasized ? 0.96 : 0.66;
  const typeColor = TYPE_COLORS[node.type];
  const core = new Mesh(
    geometryForConcept(node.type, node.radius * (emphasized ? 1.16 : 1)),
    new MeshStandardMaterial({
      color: typeColor,
      emissive: new Color(typeColor).multiplyScalar(0.28),
      emissiveIntensity: emphasized ? 1 : 0.68,
      roughness: 0.42,
      metalness: 0.08,
      transparent: true,
      opacity,
      depthWrite: !node.dimmed || emphasized,
    }),
  );
  group.add(core);
  const ring = orbitRing(node.radius * 1.55, node.clusterColor, opacity * 0.7);
  ring.rotation.x = Math.PI * 0.5;
  group.add(ring);

  if (emphasized || node.labelVisible) {
    const label = createTextSprite(splitLabel(node.label, 34), {
      accent: typeColor,
      detail: node.type.replace('_', ' '),
      width: emphasized ? 68 : 54,
      opacity,
      fontSize: emphasized ? 34 : 30,
    });
    if (label) {
      label.position.set(0, node.radius + 10, 0);
      group.add(label);
    }
  }
  return group;
}

function fieldObject(node: SceneNode, selected: boolean, hovered: boolean) {
  const group = new Group();
  const emphasized = selected || hovered;
  const opacity = node.dimmed && !hovered ? 0.12 : 1;

  const hitTarget = new Mesh(
    new SphereGeometry(14, 14, 10),
    new MeshBasicMaterial({
      color: node.clusterColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  group.add(hitTarget);

  const beacon = new Mesh(
    new OctahedronGeometry(emphasized ? 3.3 : 2.5),
    new MeshStandardMaterial({
      color: node.clusterColor,
      emissive: new Color(node.clusterColor).multiplyScalar(0.72),
      emissiveIntensity: emphasized ? 1.45 : 1,
      roughness: 0.28,
      metalness: 0.18,
      transparent: true,
      opacity: 0.82 * opacity,
      depthWrite: false,
    }),
  );
  group.add(beacon);

  [7.5, 10.5].forEach((radius, index) => {
    const orbit = orbitRing(
      radius,
      node.clusterColor,
      (emphasized ? 0.62 - index * 0.12 : 0.25 - index * 0.05) * opacity,
    );
    orbit.rotation.x = Math.PI * (0.2 + index * 0.28);
    orbit.rotation.y = Math.PI * (0.12 + index * 0.2);
    group.add(orbit);
  });

  const label = createTextSprite(splitLabel(node.label, 31), {
    accent: node.clusterColor,
    detail: `${node.primaryCount ?? 0} core  |  ${node.bridgeCount ?? 0} bridge`,
    width: emphasized ? 98 : 84,
    opacity: (emphasized ? 1 : 0.94) * opacity,
    fontSize: emphasized ? 36 : 32,
  });
  if (label) {
    label.position.set(0, emphasized ? 20 : 17, 0);
    group.add(label);
  }
  return group;
}

export function createNodeObject(node: SceneNode, selected: boolean, hovered: boolean) {
  if (node.kind === 'paper') return paperObject(node, selected, hovered);
  if (node.kind === 'field') return fieldObject(node, selected, hovered);
  return conceptObject(node, selected, hovered);
}

function ellipseContour(field: SceneField, plane: 'xy' | 'xz' | 'yz', opacity: number) {
  const points = Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    if (plane === 'xy') {
      return new Vector3(
        field.center.x + cosine * field.radii.x,
        field.center.y + sine * field.radii.y,
        field.center.z,
      );
    }
    if (plane === 'xz') {
      return new Vector3(
        field.center.x + cosine * field.radii.x,
        field.center.y,
        field.center.z + sine * field.radii.z,
      );
    }
    return new Vector3(
      field.center.x,
      field.center.y + cosine * field.radii.y,
      field.center.z + sine * field.radii.z,
    );
  });
  return new LineLoop(
    new BufferGeometry().setFromPoints(points),
    new LineBasicMaterial({
      color: field.color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function fieldParticles(field: SceneField) {
  const positions: number[] = [];
  const count = 42 + Math.min(86, field.paperCount * 9);
  for (let index = 0; index < count; index += 1) {
    const key = `${field.cluster.id}:${index}`;
    const theta = seeded(key, 0x9e3779b9) * Math.PI * 2;
    const vertical = seeded(key, 0x85ebca6b) * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    const radius = Math.cbrt(seeded(key, 0xc2b2ae35)) * 0.95;
    positions.push(
      field.center.x + Math.cos(theta) * ring * radius * field.radii.x,
      field.center.y + vertical * radius * field.radii.y,
      field.center.z + Math.sin(theta) * ring * radius * field.radii.z,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return new Points(
    geometry,
    new PointsMaterial({
      color: field.color,
      size: field.selected ? 1.8 : 1.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: field.dimmed ? 0.025 : field.selected ? 0.27 : 0.115,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function fieldShell(field: SceneField) {
  const shell = new Mesh(
    new SphereGeometry(1, 22, 15),
    new MeshBasicMaterial({
      color: field.color,
      transparent: true,
      opacity: field.dimmed ? 0.008 : field.selected ? 0.045 : 0.024,
      wireframe: false,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  shell.position.set(field.center.x, field.center.y, field.center.z);
  shell.scale.set(field.radii.x, field.radii.y, field.radii.z);
  return shell;
}

function starfield(scene: SceneData) {
  const positions: number[] = [];
  const colors: number[] = [];
  const extent = Math.max(
    Math.abs(scene.bounds.xMin),
    Math.abs(scene.bounds.xMax),
    Math.abs(scene.bounds.yMin),
    Math.abs(scene.bounds.yMax),
    Math.abs(scene.bounds.zMin),
    Math.abs(scene.bounds.zMax),
    420,
  );
  const count = 1_120;
  for (let index = 0; index < count; index += 1) {
    const theta = index * GOLDEN_ANGLE;
    const y = 1 - ((index + 0.5) / count) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const radius = extent * 1.7 + ((index * 73) % Math.round(extent * 1.6));
    positions.push(
      Math.cos(theta) * ring * radius,
      y * radius,
      Math.sin(theta) * ring * radius,
    );
    const color = new Color(STAR_COLORS[index % STAR_COLORS.length]);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return new Points(
    geometry,
    new PointsMaterial({
      size: 1.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.46,
      vertexColors: true,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function timeAxis(scene: SceneData) {
  const group = new Group();
  if (!scene.years.length) return group;
  const y = scene.bounds.yMin - 42;
  const z = scene.bounds.zMin - 25;
  const start = new Vector3(scene.bounds.xMin - 24, y, z);
  const end = new Vector3(scene.bounds.xMax + 24, y, z);
  group.add(
    new Line(
      new BufferGeometry().setFromPoints([start, end]),
      new LineBasicMaterial({
        color: '#82949d',
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    ),
  );

  const centerYear = (Math.min(...scene.years) + Math.max(...scene.years)) / 2;
  scene.years.forEach((year) => {
    const x = (year - centerYear) * 72;
    group.add(
      new Line(
        new BufferGeometry().setFromPoints([
          new Vector3(x, y - 3, z),
          new Vector3(x, y + 3, z),
        ]),
        new LineBasicMaterial({
          color: '#82949d',
          transparent: true,
          opacity: 0.46,
          depthWrite: false,
        }),
      ),
    );
    const label = createTextSprite([String(year)], {
      accent: '#76909b',
      width: 20,
      opacity: 0.84,
      fontSize: 34,
    });
    if (label) {
      label.position.set(x, y - 11, z);
      group.add(label);
    }
  });
  return group;
}

export function createSceneBackdrop(scene: SceneData) {
  const group = new Group();
  group.name = 'litbench-literature-universe';
  group.add(starfield(scene));
  scene.fields.forEach((field) => {
    group.add(fieldParticles(field));
    group.add(fieldShell(field));
    const opacity = field.dimmed ? 0.02 : field.selected ? 0.28 : 0.12;
    if (field.selected) group.add(ellipseContour(field, 'xz', opacity));
    if (field.selected) group.add(ellipseContour(field, 'yz', opacity * 0.76));
  });
  if (scene.lens === 'time') group.add(timeAxis(scene));
  return group;
}

export function disposeSceneObject(object: Object3D) {
  object.traverse((child) => {
    const item = child as Object3D & {
      geometry?: { dispose: () => void };
      material?: Material | Material[];
    };
    item.geometry?.dispose();
    const materials = Array.isArray(item.material)
      ? item.material
      : item.material
        ? [item.material]
        : [];
    materials.forEach((material) => {
      const withMap = material as Material & { map?: CanvasTexture | null };
      withMap.map?.dispose();
      material.dispose();
    });
  });
}
