/**
 * 主机头像（移植 Netcatty `components/DistroAvatar.tsx`）。
 *
 * 优先使用自动探测到的 `profile.distro`（normalize 后查品牌色 + svg）；
 * 缺失时沿用原有分支：串口（琥珀 + USB）/ 本地（Windows 徽标）/
 * 自定义图标颜色 / SSH 主色回退 Server。颜色与尺寸表沿用 Netcatty，
 * 徽标文件来自 `public/distro/*.svg`。
 */

import { useState } from "react";
import { Server, Usb } from "lucide-react";
import type { Profile } from "../backend/client";

export const DISTRO_LOGOS: Record<string, string> = {
  ubuntu: "/distro/ubuntu.svg",
  debian: "/distro/debian.svg",
  centos: "/distro/centos.svg",
  rocky: "/distro/rocky.svg",
  fedora: "/distro/fedora.svg",
  arch: "/distro/arch.svg",
  alpine: "/distro/alpine.svg",
  amazon: "/distro/amazon.svg",
  opensuse: "/distro/opensuse.svg",
  redhat: "/distro/redhat.svg",
  oracle: "/distro/oracle.svg",
  kali: "/distro/kali.svg",
  almalinux: "/distro/almalinux.svg",
  alinux: "/distro/alinux.svg",
  openeuler: "/distro/openeuler.svg",
  // OS-level logos
  macos: "/distro/macos.svg",
  freebsd: "/distro/freebsd.svg",
  windows: "/distro/windows.svg",
  linux: "/distro/linux.svg",
  // Network device vendors
  cisco: "/distro/cisco.svg",
  juniper: "/distro/juniper.svg",
  huawei: "/distro/huawei.svg",
  h3c: "/distro/h3c.svg",
  hpe: "/distro/hpe.svg",
  mikrotik: "/distro/mikrotik.svg",
  fortinet: "/distro/fortinet.svg",
  paloalto: "/distro/paloalto.svg",
  zyxel: "/distro/zyxel.svg",
};

export const DISTRO_COLORS: Record<string, string> = {
  ubuntu: "#E95420",
  debian: "#A81D33",
  centos: "#9C27B0",
  rocky: "#0B9B69",
  fedora: "#3C6EB4",
  arch: "#1793D1",
  alpine: "#0D597F",
  amazon: "#FF9900",
  opensuse: "#73BA25",
  redhat: "#EE0000",
  oracle: "#C74634",
  kali: "#0F6DB3",
  almalinux: "#173B66",
  alinux: "#FF6A00",
  openeuler: "#002FA7",
  macos: "#333333",
  freebsd: "#AB2B28",
  windows: "#0078D4",
  linux: "#333333",
  cisco: "#1BA0D7",
  juniper: "#0A6EB4",
  huawei: "#CF0A2C",
  h3c: "#ffffff",
  hpe: "#01A982",
  mikrotik: "#293239",
  fortinet: "#EE3124",
  paloalto: "#FA582D",
  zyxel: "#00497A",
  default: "#475569",
};

export type DistroAvatarSize = "xs" | "sm" | "md" | "tree" | "log" | "lg";

/** 尺寸表：边长 / 图标边长 / 圆角（对齐 Netcatty 的 xs~lg）。 */
const SIZES: Record<
  DistroAvatarSize,
  { size: number; icon: number; radius: number }
> = {
  xs: { size: 16, icon: 10, radius: 4 },
  sm: { size: 20, icon: 12, radius: 5 },
  md: { size: 32, icon: 16, radius: 8 },
  tree: { size: 24, icon: 14, radius: 6 },
  log: { size: 36, icon: 20, radius: 10 },
  lg: { size: 44, icon: 20, radius: 12 },
};

/** Netcatty 串口头像：bg-amber-600 + 白字。 */
const AMBER = "#D97706";

/** 网络设备厂商 ID（探测结果可能已是这些值，normalize 时原样保留）。 */
const NETWORK_DEVICE_IDS = [
  "cisco",
  "juniper",
  "huawei",
  "h3c",
  "hpe",
  "mikrotik",
  "fortinet",
  "paloalto",
  "zyxel",
  "ruijie",
];

/**
 * 把任意探测结果归一成标准发行版 ID。
 * 关键字表与顺序照抄 Netcatty `domain/host.ts` 的 `normalizeDistroId`。
 */
export function normalizeDistroId(value?: string | null): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (
    v === "darwin" ||
    v === "macos" ||
    v === "mac os" ||
    v === "mac os x" ||
    v.includes("darwin kernel") ||
    v.includes("macos") ||
    v.includes("mac os")
  ) {
    return "macos";
  }
  if (v === "windows" || v === "win32" || v.startsWith("openssh_for_windows")) {
    return "windows";
  }
  if (v.includes("freebsd")) return "freebsd";
  if (v.includes("ubuntu")) return "ubuntu";
  if (v.includes("debian")) return "debian";
  if (v.includes("centos")) return "centos";
  if (v.includes("rocky")) return "rocky";
  if (v.includes("fedora")) return "fedora";
  if (v.includes("arch") || v.includes("manjaro")) return "arch";
  if (v.includes("alpine")) return "alpine";
  if (v.includes("amzn") || v.includes("amazon") || v.includes("aws")) {
    return "amazon";
  }
  if (v.includes("opensuse") || v.includes("suse") || v.includes("sles")) {
    return "opensuse";
  }
  if (v.includes("red hat") || v.includes("redhat") || v.includes("rhel")) {
    return "redhat";
  }
  if (v.includes("almalinux")) return "almalinux";
  if (v.includes("oracle")) return "oracle";
  if (v.includes("kali")) return "kali";
  if (v.includes("openeuler") || v.includes("open euler")) return "openeuler";
  // Alibaba Cloud Linux：必须在通用 linux 兜底之前（alinux 含 linux）。
  if (v.includes("alinux") || v.includes("aliyun") || v.includes("alibaba cloud")) {
    return "alinux";
  }
  if (NETWORK_DEVICE_IDS.includes(v)) return v;
  if (v === "linux" || v.includes("linux")) return "linux";
  return null;
}

interface Props {
  profile: Pick<Profile, "protocol" | "icon_color" | "name" | "distro">;
  size?: DistroAvatarSize;
  className?: string;
}

export function DistroAvatar({ profile, size = "md", className }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const dims = SIZES[size];
  const boxClass = `nc-distro-avatar nc-distro-avatar-${size}${
    className ? ` ${className}` : ""
  }`;
  const boxStyle = {
    width: dims.size,
    height: dims.size,
    borderRadius: dims.radius,
  };

  // 自动探测到的发行版 / 设备厂商优先。
  const detected = normalizeDistroId(profile.distro);
  const detectedLogo = detected ? DISTRO_LOGOS[detected] : undefined;
  if (detected && detectedLogo) {
    const isH3c = detected === "h3c";
    return (
      <div
        className={boxClass}
        style={{
          ...boxStyle,
          backgroundColor: DISTRO_COLORS[detected] ?? DISTRO_COLORS.default,
        }}
      >
        {imageFailed ? (
          <Server size={dims.icon} style={{ color: "#fff" }} />
        ) : (
          <img
            src={detectedLogo}
            alt={profile.name}
            className={`nc-distro-avatar-img${isH3c ? " is-h3c" : ""}`}
            style={isH3c ? undefined : { width: dims.icon, height: dims.icon }}
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    );
  }

  if (profile.protocol === "serial") {
    return (
      <div className={boxClass} style={{ ...boxStyle, backgroundColor: AMBER, color: "#fff" }}>
        <Usb size={dims.icon} />
      </div>
    );
  }

  if (profile.protocol === "local") {
    return (
      <div className={boxClass} style={{ ...boxStyle, backgroundColor: DISTRO_COLORS.windows }}>
        {imageFailed ? (
          <Server size={dims.icon} style={{ color: "#fff" }} />
        ) : (
          <img
            src={DISTRO_LOGOS.windows}
            alt={profile.name}
            className="nc-distro-avatar-img"
            style={{ width: dims.icon, height: dims.icon }}
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    );
  }

  const customColor = profile.icon_color?.trim();
  return (
    <div
      className={boxClass}
      style={{
        ...boxStyle,
        backgroundColor: customColor || "hsl(var(--primary))",
        color: "#fff",
      }}
    >
      <Server size={dims.icon} />
    </div>
  );
}
