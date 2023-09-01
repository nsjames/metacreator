const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const seedrandom = require('seedrandom');
const crypto = require('crypto');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');



const generateNFTs = async(persistFiles = true) => {
    const dir = process.cwd();
    const files = fs.readdirSync(dir).sort();

    const quit = msg => {
        console.error(msg);
        process.exit(1);
    }

    if(!files.includes('metacreator.json')){
        quit("This directory does not have a 'metacreator.json' file.");
    }

    let meta;


    try {
        meta = JSON.parse(fs.readFileSync(`${dir}/metacreator.json`));
    } catch(e){
        quit(e.message);
    }
    console.log(meta)

    const isPNG = meta.hasOwnProperty('png') && !!meta.png;
    const suffix = isPNG ? 'png' : 'jpg'

    if(!meta.hasOwnProperty('layers')){
        quit("Layers not specified in meta json");
    }

    for(let layer in meta.layers){
        if(!files.includes(layer)){
            quit(`Layer "${layer}" does not have a directory`);
        }
    }


    let outputPath = `${dir}/outputs`
    let outputSizes = { width:500, height:500 };
    if(meta.hasOwnProperty('output')){
        if(meta.output.hasOwnProperty('path')) outputPath = meta.output.path;
        if(meta.output.hasOwnProperty('width')) outputSizes.width = meta.output.width;
        if(meta.output.hasOwnProperty('height')) outputSizes.height = meta.output.height;
    }

    let size = 10000;
    if(meta.hasOwnProperty('size')){
        if(typeof meta.size !== "number") quit("Invalid meta size type (must be number)");
        if(meta.size <= 0) quit("Invalid meta size");
        size = meta.size;
    }

    let description = "";
    let namePrefix = "";
    if(meta.hasOwnProperty('metadata')){
        if(meta.metadata.hasOwnProperty('description')) description = meta.metadata.description;
        if(meta.metadata.hasOwnProperty('namePrefix')) namePrefix = meta.metadata.namePrefix;
    }

    let layers = {};
    for(let layer in meta.layers){
        if(!layers.hasOwnProperty(layer)) layers[layer] = [];
        const layerFiles = fs.readdirSync(`${dir}/${layer}`).sort();
        for(let file of layerFiles){
            const nameSplit = file.split('.')[0].split('#');
            const name = nameSplit[0];
            const max = parseInt(nameSplit[1] || 0)
            layers[layer].push({
                img:await loadImage(`${dir}/${layer}/${file}`),
                name,
                max,
                used:0
            });
        }
    }

    let layerOrder = [];
    for(let layer in meta.layers){
        layerOrder.push(layer);
    }

    let seed = Math.round(Math.random() * 10000000);
    if(meta.hasOwnProperty('seed')){
        seed = meta.seed;
    }

    try { fs.mkdirSync(`${outputPath}/`, true) } catch(e){}
    try { fs.mkdirSync(`${outputPath}/images/`, true) } catch(e){}
    try { fs.mkdirSync(`${outputPath}/jsons/`, true) } catch(e){}

    // We want a deterministic random based on a seed so that we can:
    // - Regenerate a project
    // - Use different seeds until we find a series we like
    const rng = seedrandom(seed);

    // 1 of 1s should be randomly inserted each time, overtaking one of the 10k
    let uniqueCount = 0;
    let uniqueFiles;
    try {
        uniqueFiles = fs.readdirSync(`${dir}/1of1s`).sort();
        uniqueCount = uniqueFiles.length;
    } catch(e){}
    let uniquePositions = {};
    for(let i = 0; i < uniqueCount; i++){
        let position;
        do {
            position = Math.floor(rng() * size);
        } while(uniquePositions.hasOwnProperty(position));

        uniquePositions[position] = await loadImage(`${dir}/1of1s/${uniqueFiles[i]}`);
    }

    let generated = [];
    let jsons = [];

    const generateNFT = async i => {
        console.log(`Creating NFT# ${i+1}`)
        let imgBuf;
        let shaImgBuf;
        const canvas = createCanvas(outputSizes.width, outputSizes.height);
        const ctx = canvas.getContext('2d')
        ctx.globalCompositeOperation = "source-over";

        let attributes = {};

        const imgOut = persistFiles ? fs.createWriteStream(`${outputPath}/images/${i+1}.${suffix}`) : null;
        if(uniquePositions.hasOwnProperty(i)){
            ctx.drawImage(uniquePositions[i], 0, 0, outputSizes.width, outputSizes.height);
            // imgBuf = canvas.toBuffer("image/png");
            imgBuf = isPNG ? canvas.createPNGStream() : canvas.createJPEGStream();
        } else {
            let details = [];
            let attempts = 0;

            do {
                ctx.clearRect(0, 0, outputSizes.width, outputSizes.height);
                attempts++;
                if(attempts >= 1000) quit("Over 1000 attempts to generate a new NFT have failed.");

                let selectedLayers = [];
                for(let layer of layerOrder){
                    const getImg = () => {
                        let tmp = layers[layer][Math.floor(rng() * layers[layer].length)];
                        if(tmp.max !== 0 && tmp.used >= tmp.max) return getImg();
                        return tmp;
                    }

                    const img = getImg();
                    selectedLayers.push(img.name);
                    ctx.drawImage(img.img, 0, 0, outputSizes.width, outputSizes.height);
                    details.push({img, layer});
                }

                // PNG IS SLOWER!
                imgBuf = isPNG ? canvas.createPNGStream() : canvas.createJPEGStream();
                shaImgBuf = sha256(selectedLayers.join(','))
            } while (generated.includes(shaImgBuf));
            generated.push(shaImgBuf);

            details.map(x => {
                x.img.used++;
                attributes[x.layer] = x.img.name;
            });
        }

        if(persistFiles) {
            imgBuf.pipe(imgOut);
            await new Promise(r => imgOut.on('finish', r))
        }

        if(meta.hasOwnProperty('traits')){
            // Rands are used to check whether the trait will be added, and what the value would be.
            // We need to calculate them for all since we need everything to be deterministic
            const traitRands = [...Array(Object.keys(meta.traits).length).keys()]
                .map(() => [rng() /* chance */, rng() /* value */]);

            let i = -1;
            for(let trait in meta.traits){
                i++;
                const {chance, range, values} = meta.traits[trait];


                if(Math.floor(traitRands[i][0] * size) >= chance) continue;

                if(range && range.length){
                    const picked = (traitRands[i][1] * parseFloat(range[1])) + range[0];
                    const isFloat = range[1].toString().indexOf('.') > -1;
                    const decimals = isFloat ? range[1].toString().split('.')[1].length : 0;
                    attributes[trait] = isFloat ? parseFloat(picked.toFixed(decimals)) : parseInt(Math.round(picked));
                }

                if(values && values.length){
                    const picked = values[Math.floor(traitRands[i][1] * values.length)];
                    attributes[trait] = picked;
                }
            }
        }

        attributes = Object.keys(attributes).reduce((acc, x) => {
            acc.push({ trait_type: x, value:attributes[x] })
            return acc;
        }, [])

        let metadata = {
            name:`${namePrefix}#${i+1}`,
            description,
            image:'',
            external_url:'',
            attributes,
            dna:sha256(shaImgBuf + sha256(JSON.stringify(attributes)))
        }

        if(persistFiles) fs.writeFileSync(
            `${outputPath}/jsons/${i+1}.json`,
            JSON.stringify(metadata, null, 4)
        );
        else jsons.push(metadata);
    }

    for(let i = 0; i < size; i++) await generateNFT(i);

    return jsons;
};

const GIFEncoder = require('gifencoder');
const pngFileStream = require('png-file-stream');
const createGif = async (args) => {

    const Args = require('args');
    Args
        .option('path', '', process.cwd())

    const flags = Args.parse(['', '', ...args]);

    let imagesPath = flags.path;

    const encoder = new GIFEncoder(1500, 1500   );

    const stream = pngFileStream(`${imagesPath}/*.png`)
        .pipe(encoder.createWriteStream({ repeat: -1, delay: 250, quality: 10 }))
        .pipe(fs.createWriteStream('animated.gif'));

    await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
};


const calcRaritiesInternal = (jsons, exclude = []) => {
    let attrs = {};
    for(let json of jsons){
        for(let trait in json.attributes){
            if(exclude.includes(json.attributes[trait].trait_type.toLowerCase())) continue;
            const type = `${json.attributes[trait].trait_type}::${json.attributes[trait].value}`;
            if(!attrs.hasOwnProperty(type)) attrs[type] = 0;
            attrs[type]++;
        }
    }

    attrs = Object.keys(attrs).reduce((acc,x) => {
        acc.push({ attribute:x, value:attrs[x] })
        return acc;
    }, []).sort((a,b) => {
        return a.value > b.value ? -1 : 1;
    })

    fs.writeFileSync(
        `${process.cwd()}/rarities.json`,
        JSON.stringify(attrs, null, 4)
    )

    console.log(attrs);
}

const calcRarities = (args) => {

    const Args = require('args');
    Args
        .option('path', '', process.cwd())
        .option('exclude', '', '')

    const flags = Args.parse(['', '', ...args]);

    let jsonsPath = flags.path;
    let exclude = flags.exclude.split(',').map(x => x.trim().toLowerCase());

    const files = fs.readdirSync(jsonsPath);
    const jsons = [];
    for(let file of files){
        jsons.push(JSON.parse(fs.readFileSync(`${jsonsPath}/${file}`)));
    }

    calcRaritiesInternal(jsons, exclude);
};

const variationTest = async() => {
    const jsons = await generateNFTs(false);
    calcRaritiesInternal(jsons, []);

};

module.exports = (argv) => {
    if(argv.length === 0){
        return generateNFTs();
    }

    switch(argv[0].toLowerCase()){
        case "rarity": return calcRarities(argv.slice(1));
        case "gif": return createGif(argv.slice(1));
        case "test": return variationTest(argv.slice(1));
    }
}

