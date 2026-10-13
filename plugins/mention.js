const { Module } = require('../main');
const config = require('../config');
const axios = require('axios');

const audios = 'https://files.catbox.moe/vew5cq.mp4,https://files.catbox.moe/j0lwwi.mp4,https://files.catbox.moe/zxejb5.mp4';
const image = 'https://i.ibb.co/prQLPMcY/temp.jpg,https://i.ibb.co/tTR9Z9kZ/temp.jpg';
const title = 'ROMD-MD';
const body = 'ANSAD SER';
const url = 'https://www.instagram.com/___ansad_';
const isPtt = true;

const getBuffer = async (mediaUrl) => {
    try {
        const res = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    } catch {
        return null;
    }
};

Module({
    on: 'text',
    fromMe: false
}, async (message) => {
    if (message.fromMe) return;

    const sudoList = (config.SUDO || '')
        .split(',')
        .map((num) => num.replace(/[^0-9]/g, ''))
        .filter(Boolean);

    const botNumber = (message.myjid || '').split('@')[0].split(':')[0];
    if (botNumber) sudoList.push(botNumber);

    const mentionedJids = message.mention || [];
    const messageText = message.text || '';

    const isMentioned = sudoList.some((sudoNum) => {
        const matchesMention = mentionedJids.some((jid) => jid.includes(sudoNum));
        const matchesText = messageText.includes(`@${sudoNum}`);
        return matchesMention || matchesText;
    });

    if (!isMentioned) return;

    const imageList = image.split(',');
    const randomImage = imageList[Math.floor(Math.random() * imageList.length)].trim();

    const audioList = audios.split(',');
    const randomAudio = audioList[Math.floor(Math.random() * audioList.length)].trim();

    const [audioBuffer, thumbBuffer] = await Promise.all([
        getBuffer(randomAudio),
        getBuffer(randomImage)
    ]);

    if (!audioBuffer) return;

    return await message.client.sendMessage(message.jid, {
        audio: audioBuffer,
        mimetype: 'audio/mp4',
        ptt: isPtt,
        contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                thumbnail: thumbBuffer,
                sourceUrl: url,
                showAdAttribution: true,
                renderLargerThumbnail: true
            }
        }
    }, { quoted: message.data });
});
