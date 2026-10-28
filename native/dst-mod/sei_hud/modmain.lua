-- Client-only: the host's app exposes a read-only local status endpoint.
local G = GLOBAL
local require = G.require
local Text = require("widgets/text")
local ImageButton = require("widgets/imagebutton")
local ChatInputScreen = require("screens/chatinputscreen")

local PORTS = { 27424, 27425, 27426, 27427, 27428 }
local commands = {
    { "快跟上", "快跟上我" },
    { "砍树", "帮我砍树" },
    { "挖矿", "帮我挖矿" },
    { "保护我", "请保护我，跟紧我" },
    { "存材料", "把材料放到附近的仓库里" },
}
local activity = {
    idle = "待命", ["goto"] = "移动", follow = "跟随", gather = "采集",
    action = "工作", build = "制作", attack = "战斗", flee = "撤退",
    lightfire = "照料火堆", container = "整理物品", give = "递送物品",
}
local function rounded(value)
    return math.floor((tonumber(value) or 0) + .5)
end

local function button(parent, title, x, y, onclick)
    local b = parent:AddChild(ImageButton("images/global.xml", "square.tex", "square.tex", "square.tex"))
    b:SetPosition(x, y)
    b:ForceImageSize(78, 30)
    b:SetFont(G.TALKINGFONT)
    b:SetTextSize(18)
    b:SetTextColour(0, 0, 0, 1)
    b.scale_on_focus = false
    b:SetText(title)
    b:SetOnClick(onclick)
    return b
end

local function addHud(controls)
    if controls.seiHud ~= nil or controls.topleft_root == nil then return end
    local root = controls.topleft_root:AddChild(require("widgets/widget")("SeiHud"))
    controls.seiHud = root
    root:SetPosition(150, -135)
    root:Hide()
    local card = button(root, "Sei", 0, 0, function()
        if G.TheFrontEnd ~= nil then G.TheFrontEnd:PushScreen(ChatInputScreen(false)) end
    end)
    card:ForceImageSize(390, 36)
    card:SetTextSize(22)
    local info = root:AddChild(Text(G.TALKINGFONT, 22, ""))
    info:SetPosition(0, -35)
    info:SetClickable(false)
    local quick = {}
    for i, spec in ipairs(commands) do
        local command = spec[2]
        quick[i] = button(root, spec[1], (i - 3) * 82, -75, function()
            if G.TheNet ~= nil then G.TheNet:Say(command, false) end
        end)
    end
    local activePort = nil
    local function poll(port)
        G.TheSim:QueryServer("http://127.0.0.1:" .. tostring(port) .. "/hud", function(result, ok, code)
            if not ok or code ~= 200 then
                if activePort == port then activePort = nil; root:Hide() end
                return
            end
            local success, data = pcall(G.json.decode, result)
            if not success or type(data) ~= "table" or data.app ~= "sei" then return end
            activePort = port
            local s = data.companion
            if type(s) ~= "table" then root:Hide(); return end
            root:Show()
            card:SetText(tostring(s.name or "Sei") .. "  ·  " .. (activity[s.activity] or tostring(s.activity or "待命")))
            info:SetString(string.format("生命 %d/%d    饥饿 %d/%d    理智 %d/%d",
                rounded(s.health), rounded(s.healthMax), rounded(s.hunger), rounded(s.hungerMax), rounded(s.sanity), rounded(s.sanityMax)))
        end, "GET")
    end
    root.inst:DoPeriodicTask(2, function()
        if activePort ~= nil then poll(activePort) else for _, port in ipairs(PORTS) do poll(port) end end
    end, 0)
end

AddClassPostConstruct("widgets/controls", addHud)
