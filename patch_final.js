const fs = require('fs');

const p = 'packages/ios-agent/src/DeviceChromeLoader.ts';
let code = fs.readFileSync(p, 'utf-8');

code = code.replace(
  /        const screenRect: ChromeRect = \{\n          x:      Math\.round\(\(leftWidth \+ btnM\.left\) \* scale\),\n          y:      Math\.round\(\(topHeight \+ btnM\.top\)  \* scale\),\n          width:  Math\.round\(screenW \* scale\),\n          height: Math\.round\(screenH \* scale\),\n        \}\n\n        return \{\n          framePng: readFileSync\(framePath\)\.toString\('base64'\),\n          bezelWidth:  Math\.round\(\(pdfSize\.width  - paddingLeft - paddingRight\)  \* scale\),\n          bezelHeight: Math\.round\(\(pdfSize\.height - paddingTop  - paddingBottom\) \* scale\),\n          compositeWidth:  Math\.round\(expandedW \* scale\),\n          compositeHeight: Math\.round\(expandedH \* scale\),\n          padding: \{\n            left:   Math\.round\(paddingLeft   \* scale\),\n            right:  Math\.round\(paddingRight  \* scale\),\n            top:    Math\.round\(paddingTop    \* scale\),\n            bottom: Math\.round\(paddingBottom \* scale\),\n          \},\n          screenRect,\n          screenCornerRadius: Math\.round\(screenCornerRadius1x \* scale\),\n          logicalWidth:  Math\.round\(screenW\),\n          logicalHeight: Math\.round\(screenH\),\n          buttons,\n        \}/,
  `        const screenRect: ChromeRect = {
          x:      Math.round((leftWidth + btnM.left) * scale),
          y:      Math.round((topHeight + btnM.top)  * scale),
          width:  Math.round(screenW * scale),
          height: Math.round(screenH * scale),
        }

        const screenSize = loadProfileScreenSize(typeIdentifier)
        const logicalWidth = screenSize ? screenSize.width : Math.round(screenW)
        const logicalHeight = screenSize ? screenSize.height : Math.round(screenH)

        return {
          framePng: readFileSync(framePath).toString('base64'),
          bezelWidth:  Math.round((pdfSize.width  - paddingLeft - paddingRight)  * scale),
          bezelHeight: Math.round((pdfSize.height - paddingTop  - paddingBottom) * scale),
          compositeWidth:  Math.round(expandedW * scale),
          compositeHeight: Math.round(expandedH * scale),
          padding: {
            left:   Math.round(paddingLeft   * scale),
            right:  Math.round(paddingRight  * scale),
            top:    Math.round(paddingTop    * scale),
            bottom: Math.round(paddingBottom * scale),
          },
          screenRect,
          screenCornerRadius: Math.round(screenCornerRadius1x * scale),
          logicalWidth,
          logicalHeight,
          buttons,
        }`
);

fs.writeFileSync(p, code);
