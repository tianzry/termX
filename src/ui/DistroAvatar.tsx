/**
 * 主机头像（移植 Netcatty `components/DistroAvatar.tsx`）。
 *
 * termX 的 Profile 没有 distro 字段，因此只保留可用的分支：
 * 串口（琥珀 + USB）/ 本地（Windows 徽标）/ 自定义图标颜色 / SSH 主色回退。
 * 颜色与尺寸表沿用 Netcatty，徽标文件来自 `public/distro/*.svg`。
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

interface Props {
  profile: Pick<Profile, "protocol" | "icon_color" | "name">;
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
