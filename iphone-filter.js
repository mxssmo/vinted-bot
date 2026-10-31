/**
 * iPhone filter module for Vinted listings with comprehensive variant handling
 */

// Define the base iPhone models and their variations
const IPHONE_MODELS = {
    '12': {
        base: ['12'],
        variants: ['pro', 'pro max', 'promax', 'pro-max']
    },
    '13': {
        base: ['13'],
        variants: ['', 'pro', 'pro max', 'promax', 'pro-max']
    },
    '14': {
        base: ['14'],
        variants: ['', 'pro', 'pro max', 'promax', 'pro-max']
    },
    '15': {
        base: ['15'],
        variants: ['', 'pro', 'pro max', 'promax', 'pro-max']
    }
};

// Different ways iPhone might be written
const IPHONE_VARIANTS = [
    'iphone',
    'Iphone',
    'IPHONE',
    'iPHONE',
    'iPhone',
    'I phone',
    'i phone',
    'I-phone',
    'i-phone'
];

// Different types of separators that might be used
const SEPARATORS = [
    '', // no separator
    ' ', // space
    '-', // hyphen
    '_', // underscore
    '.', // dot
    ':', // colon
    '/', // forward slash
    '\\', // backslash
    '|' // vertical bar
];

/**
 * Generates all possible variations of an iPhone model string
 * @param {string} baseModel - The base model number (e.g., '12', '13')
 * @param {string} variant - The variant (e.g., 'pro', 'pro max')
 * @returns {string[]} Array of all possible variations
 */
const generateModelVariations = (baseModel, variant) => {
    const variations = [];
    
    // Generate all iPhone spelling variations
    IPHONE_VARIANTS.forEach(iphoneVariant => {
        // Generate separator variations
        SEPARATORS.forEach(sep1 => {
            // Base model variations
            const baseVariations = [
                `${iphoneVariant}${sep1}${baseModel}`, // iPhone 12
                `${iphoneVariant}${baseModel}` // iPhone12
            ];
            
            if (variant) {
                // Add variant combinations with different separators
                SEPARATORS.forEach(sep2 => {
                    baseVariations.forEach(base => {
                        variations.push(
                            `${base}${sep2}${variant}`, // iPhone 12 pro max
                            `${base}${variant}`, // iPhone12promax
                            `${base}${sep2}${variant.replace(' ', '')}`, // iPhone 12 promax
                            `${base}${sep2}${variant.replace(' ', '-')}`, // iPhone 12 pro-max
                            `${base}${sep2}${variant.replace(' ', '_')}` // iPhone 12 pro_max
                        );
                    });
                });
            } else {
                // If it's just the base model (like iPhone 13), add those variations
                variations.push(...baseVariations);
            }
        });
    });
    
    return [...new Set(variations)]; // Remove duplicates
};

/**
 * Checks if the item title matches allowed iPhone models
 * @param {string} title - The title of the item to check
 * @returns {boolean} - True if the item should be included in results
 */
const isAllowedIPhoneModel = (title) => {
    // Convert title to lowercase for case-insensitive matching
    title = title.toLowerCase();
    
    // Check if it's any variant of iPhone
    const isIphone = IPHONE_VARIANTS.some(variant => 
        title.toLowerCase().includes(variant.toLowerCase())
    );
    
    // If not an iPhone, let it pass through
    if (!isIphone) {
        return true;
    }
    
    // Check all possible model variations
    return Object.entries(IPHONE_MODELS).some(([baseModel, modelData]) => {
        const baseVariations = modelData.variants.map(variant => 
            generateModelVariations(baseModel, variant)
        ).flat();
        
        return baseVariations.some(variation => 
            title.includes(variation.toLowerCase())
        );
    });
};

// Export the filtering function
module.exports = {
    isAllowedIPhoneModel
};

// Example tests (commented out)
/*
const testTitles = [
    "iPhone 12 Pro Max",
    "IPHONE13PROMAX",
    "I-phone 14 pro-max",
    "iPhone15_Pro_Max",
    "i phone 13",
    "iPhone 12",
    "Regular item",
    "iPhone 11 Pro" // should not match
];

testTitles.forEach(title => {
    console.log(`${title}: ${isAllowedIPhoneModel(title)}`);
});
*/