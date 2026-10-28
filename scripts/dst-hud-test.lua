-- Lightweight client HUD contract test with mocked DST widgets/network.
local function widget()
    local w = { children = {}, shown = true }
    w.inst = { DoPeriodicTask = function(_, _, fn) w.poll = fn end }
    function w:AddChild(child) table.insert(self.children, child); return child end
    function w:SetPosition() end
    function w:Hide() self.shown = false end
    function w:Show() self.shown = true end
    function w:ForceImageSize() end
    function w:SetFont() end
    function w:SetTextSize() end
    function w:SetTextColour() end
    function w:SetText(s) self.text = s end
    function w:SetString(s) self.text = s end
    function w:SetClickable() end
    function w:SetOnClick(fn) self.onclick = fn end
    return w
end

local sent, opened, response, hook = {}, 0, nil, nil
local modules = {
    ['widgets/text'] = function() return widget() end,
    ['widgets/imagebutton'] = function() return widget() end,
    ['widgets/widget'] = function() return widget() end,
    ['screens/chatinputscreen'] = function() return { chat = true } end,
}
GLOBAL = {
    require = function(name) return assert(modules[name], name) end,
    TALKINGFONT = 'font',
    json = { decode = function() return response end },
    TheNet = { Say = function(_, text) table.insert(sent, text) end },
    TheFrontEnd = { PushScreen = function(_, s) assert(s.chat); opened = opened + 1 end },
    TheSim = { QueryServer = function(_, _, cb) cb('json', true, 200) end },
}
AddClassPostConstruct = function(name, fn) assert(name == 'widgets/controls'); hook = fn end
dofile('native/dst-mod/sei_hud/modmain.lua')
local controls = { topleft_root = widget() }
hook(controls)
local root = controls.seiHud
assert(not root.shown)
response = { app = 'sei', companion = { name = '小伙伴', health = 50, healthMax = 100, hunger = 30, hungerMax = 100, sanity = 90, sanityMax = 100, activity = 'chop' } }
root.poll()
assert(root.shown)
assert(root.children[1].text:find('小伙伴', 1, true))
assert(root.children[2].text:find('生命 50/100', 1, true))
root.children[1].onclick()
assert(opened == 1)
for i = 3, 7 do root.children[i].onclick() end
local expected = { '快跟上我', '帮我砍树', '帮我挖矿', '请保护我，跟紧我', '把材料放到附近的仓库里' }
for i, line in ipairs(expected) do assert(sent[i] == line) end
response = { app = 'sei' }
root.poll()
assert(not root.shown)
print('DST HUD interaction test passed')
