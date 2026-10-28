-- scripts/sei/speak.lua: the companion's voice.
--
-- talker:Say broadcasts a speech bubble over the body to every client.
-- TheNet:Announce puts the line in the chat log as an announcement
-- ("Name: text"); there is no public server API to post AS a named player,
-- so the prefix is ours (see the research report, 4.5). The announcement is
-- behind the mod's `announce` option and the per-summon flag.

local Speak = {}

local MAX_CHARS = 160

-- The wire limit is in bytes. Never split a multibyte character when clipping.
local function clip_utf8(text, limit)
    if #text <= limit then return text end
    local last = limit
    while last > 0 and text:byte(last + 1) >= 128 and text:byte(last + 1) < 192 do
        last = last - 1
    end
    return text:sub(1, last)
end

function Speak.Say(inst, text, announce)
    if inst == nil or not inst:IsValid() then return false end
    text = tostring(text or "")
    if #text == 0 then return false end
    text = clip_utf8(text, MAX_CHARS)
    local talker = inst.components.talker
    if talker ~= nil then
        pcall(function() talker:Say(text, nil, nil, true) end)
    end
    if announce and TheNet ~= nil then
        local name = inst.name or "Sei"
        pcall(function() TheNet:Announce(name .. ": " .. text, nil, nil, "default") end)
    end
    return true
end

return Speak
