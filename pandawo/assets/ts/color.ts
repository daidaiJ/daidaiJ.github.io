interface colorScheme {
    hash: string,                        /// Regenerate color scheme when the image hash is changed
    DarkMuted: {
        hex: string,
        rgb: Number[],
        bodyTextColor: string
    },
    Vibrant: {
        hex: string,
        rgb: Number[],
        bodyTextColor: string
    }
}

let colorsCache: { [key: string]: colorScheme } = {};

if (localStorage.hasOwnProperty('StackColorsCache')) {
    try {
        colorsCache = JSON.parse(localStorage.getItem('StackColorsCache'));
    }
    catch (e) {
        colorsCache = {};
    }
}

const NEUTRAL_PALETTE: colorScheme = {
    hash: '',
    Vibrant: { hex: '#888888', rgb: [136, 136, 136], bodyTextColor: '#ffffff' },
    DarkMuted: { hex: '#444444', rgb: [68, 68, 68], bodyTextColor: '#ffffff' }
};

async function getColor(key: string, hash: string, imageURL: string) {
    /**
     * 站点级覆盖：Vibrant 脚本（40KB）已在 footer/components/script.html 中裁剪，
     * 本函数仅 tile 布局取色用。缺失时返回中性色，保证调用方渐变逻辑不报错。
     * 如需恢复取色效果，在 script.html 重新引入 Vibrant 即可。
     */
    if (typeof Vibrant === 'undefined') {
        return { ...NEUTRAL_PALETTE, hash: hash };
    }

    if (!key) {
        /**
         * If no key is provided, do not cache the result
         */
        return await Vibrant.from(imageURL).getPalette();
    }

    if (!colorsCache.hasOwnProperty(key) || colorsCache[key].hash !== hash) {
        /**
         * If key is provided, but not found in cache, or the hash mismatches => Regenerate color scheme
         */
        const palette = await Vibrant.from(imageURL).getPalette();

        colorsCache[key] = {
            hash: hash,
            Vibrant: {
                hex: palette.Vibrant.hex,
                rgb: palette.Vibrant.rgb,
                bodyTextColor: palette.Vibrant.bodyTextColor
            },
            DarkMuted: {
                hex: palette.DarkMuted.hex,
                rgb: palette.DarkMuted.rgb,
                bodyTextColor: palette.DarkMuted.bodyTextColor
            }
        }

        /* Save the result in localStorage */
        localStorage.setItem('StackColorsCache', JSON.stringify(colorsCache));
    }

    return colorsCache[key];
}

export {
    getColor
}
